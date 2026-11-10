// ScoutBox sync backend.
// Every deck rule is enforced HERE, not in the frontends — the product's
// claims depend on the API refusing, not the UI hiding.

import express from 'express';
import { installAsyncErrorForwarding } from './domains/platform/asyncErrors.mjs';
// A rejected async handler answers 500 instead of ending the process.
installAsyncErrorForwarding();

import { optText, reqText, badField, switchRefused } from './domains/platform/input.mjs';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './seed.mjs';
import { openStore } from './store.mjs';
import { attachDataLayer } from './repositories/index.mjs';
import { STAFF_LIMITS } from './repositories/users.mjs';
import { MESSAGE_LIMITS } from './repositories/channels.mjs';
import { NOTIFICATION_LIMITS, feedItem } from './repositories/notifications.mjs';
import { createIdCounter } from './repositories/counters.mjs';
import { GRASSROOTS_LIMITS, boxAround } from './repositories/grassroots.mjs';
import { ORG_LIMITS } from './repositories/orgs.mjs';
import { CLUB_SETUP_LIMITS, LOOKING_FOR_POSITIONS } from './repositories/clubSetup.mjs';
import { TRANSITION_LIMITS, vouchCodeHash } from './repositories/transitionsVouches.mjs';
import { registerM12 } from './m12/index.mjs';
import { registerM13 } from './m13/index.mjs';
import { registerM14 } from './domains/verification/claims/index.mjs';
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
import { audienceFor, EVENT_AUDIENCE } from './domains/platform/eventAudience.mjs';
import { createRateLimiter, rateLimitedBody, RATE_LIMIT_POLICY } from './domains/platform/rateLimit.mjs';
import { buildCapabilityReport, demoSeedEnabled, devLoginsEnabled, productionConfigProblems } from './domains/platform/capabilities.mjs';
import { isLeadRole } from './roles.mjs';
import { parseTrustProxy } from './httpTrust.mjs';
import { minimizePayload, assertEventRegistry, EVENT_NAMES } from './domains/platform/eventRegistry.mjs';
import { registerNotificationPrefs } from './domains/platform/notificationPrefs.mjs';
import { registerAudit } from './domains/platform/audit.mjs';
import { createFaultLayer } from './domains/platform/faults.mjs';
import { httpContractMiddleware } from './domains/platform/httpContract.mjs';
import { integrityReport, integritySummary } from './domains/platform/integrity.mjs';
import { orgPlayerView, guardianChildView, guardianSelfView } from './views/playerViews.mjs';
import { registerGuardianAccount, registerGuardianIdReview } from './domains/identity/guardians.mjs';
import { validateContactReply } from './domains/recruitment/lifecycle/contact.mjs';
import { icsLocal as trialIcsLocal, icsText as trialIcsText } from './domains/recruitment/lifecycle/trial.mjs';
import { requestInstrumentation } from './domains/enterprise/enterprise.mjs';
import { totpValid } from './m13/shared.mjs';
import {
  PROGRAMME_TRACKS, trackForPosition, programmeProgress, pathwayFor,
  earnedGrassrootsBadges, percentileAmong, inCohort,
} from './grassrootsJourney.mjs';
import {
  hashPassword, verifyPassword, newToken, randomCode, makeRateLimiter,
  createMailer, createPushSender, createIdvProvider, createBilling, createStorage,
} from './adapters.mjs';
import {
  adultAgeFor,
  ageOn,
  isAdult,
  visibleToOrg,
  computeTrustScore,
  trustBreakdown,
  validateTrialReport,
  TRIAL_REPORT_FIELDS,
  parseTrialDate,
  isTrialDate,
  trialReportDueAt,
  validateTrialDetails,
  chooseTrialSlot,
  similarityScore,
  moderateText,
  haversineKm,
  GRASSROOTS_RADIUS_KM,
  playerLevelAfterSigning,
  trustTier,
  computeStreak,
  weeklyGoal,
  nextActions,
} from './domain.mjs';
import { parseDobStrict, parseStrictDateOnly, readInstant, utcDayOf, validateIanaZone, localParts } from './temporal.mjs';
import { readPage, sendPageError, pageOf } from './domains/platform/paging.mjs';
import { AUDIT_LIMITS } from './repositories/safetyAudit.mjs';
import { PLANS, ARCHETYPES } from './catalogue.mjs';
import { IDENTITY_LIMITS, PLAYER_POSITIONS, PLAYER_FEET } from './repositories/identity.mjs';
import { invoiceView } from './adapters.mjs';
import { createLookups } from './domains/platform/lookups.mjs';
import { createMatchFactsKeeper } from './domains/discovery/matchFacts.mjs';

/**
 * A DATE_ONLY a client typed (open day, match day, friendly,
 * attendance, medical record) is a calendar day that exists, or a 400.
 * Returns true when it is; false after sending the refusal.
 */
function dateOnlyOrRefuse(res, value, field) {
  const p = parseStrictDateOnly(value);
  if (p.ok) return true;
  res.status(400).json({ error: 'DATE_INVALID', field, message: `${field} must be a calendar day written YYYY-MM-DD (${p.why}).`, expected: 'YYYY-MM-DD' });
  return false;
}

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
const reportView = (r) => ({ id: r.id, ts: r.ts, by: r.by, byId: r.byId, byOrgId: r.byOrgId, targetKind: r.targetKind, targetOrgId: r.targetOrgId, targetScoutName: r.targetScoutName, targetPlayerId: r.targetPlayerId, reason: r.reason, urgent: r.urgent, status: r.status, outcome: r.outcome, resolvedAt: r.resolvedAt });
const filedReportView = reportView; // the reporter's own reports: the same fields
const blockView = (b) => ({ id: b.id, playerId: b.playerId, orgId: b.orgId, by: b.by, reason: b.reason, ts: b.ts });
const moderationView = (m) => ({ id: m.id, ts: m.ts, context: m.context, flags: m.flags, severity: m.severity, excerpt: m.excerpt });
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
// In-app notification feed. audience = {kind: 'player'|'guardian'|'org_user', id}.
// (Push / email delivery is a production integration behind this same record.)
// Quiet hours + the minors' school-hours mute apply to PUSH delivery: the
// in-app feed always receives the record, but `deferredPush` marks anything
// that production push infra must hold back.
// Quiet hours and the school-hours mute are WALL-CLOCK rules
// for the person, so they are evaluated in a named zone — the person's own
// when their preferences carry one, otherwise the platform's home zone —
// never in whatever zone the server process happens to run in.
const PLATFORM_HOME_ZONE = 'Europe/London';
function pushDeferred(audience, now = new Date()) {
  let prefs = null;
  let minor = false;
  if (audience.kind === 'player') {
    const p = findPlayer(audience.id);
    prefs = p?.notificationPrefs;
    minor = p ? !isAdult(p) : false;
  } else if (audience.kind === 'guardian') {
    prefs = byId.guardian(audience.id)?.notificationPrefs;
  }
  const zone = validateIanaZone(prefs?.timezone).ok ? prefs.timezone : PLATFORM_HOME_ZONE;
  const wall = localParts(now.getTime(), zone);
  const minutes = Number(wall.hour) * 60 + Number(wall.minute);
  const schoolMute = prefs?.schoolHoursMute ?? minor; // minors muted in school hours by default
  const day = new Date(Date.UTC(Number(wall.year), Number(wall.month) - 1, Number(wall.day))).getUTCDay();
  if (schoolMute && day >= 1 && day <= 5 && minutes >= 8 * 60 + 30 && minutes <= 15 * 60 + 30) return true;
  if (prefs?.quietStart && prefs?.quietEnd) {
    const [qsH, qsM] = prefs.quietStart.split(':').map(Number);
    const [qeH, qeM] = prefs.quietEnd.split(':').map(Number);
    const qs = qsH * 60 + (qsM || 0);
    const qe = qeH * 60 + (qeM || 0);
    const inQuiet = qs <= qe ? minutes >= qs && minutes < qe : minutes >= qs || minutes < qe;
    if (inQuiet) return true;
  }
  return false;
}

// How long an identical UNREAD notification stays coalescible: six hours, the
// repository's `coalesceMs` (repositories/notifications.mjs), which also owns
// the scan that decides what coalesces.

// The preference gate. Assigned once the preference module has
// registered (below); until then everything is allowed, which is the safe
// direction for the few notifications seeding may create at boot.
let notificationAllows = () => true;
let m182Ctx = null; // assigned when the preference and audit modules register, below
let agentCoreDomain = null; // assigned when the Agent core registers, below
const notificationsSuppressed = { count: 0 };

/**
 * Create (or coalesce) one notification: a row of the `notifications` table
 * (repositories/notifications.mjs), written at once — inside the unit of work
 * of the action it announces when one is open, so it commits or rolls back
 * with it, in a transaction of its own otherwise. `actionRequired:
 * { deadline }` attaches an acknowledgment contract in the same write (m13
 * notifyAction). Text longer than the table keeps is shortened (it can carry
 * names people typed). Returns the stored record or null when the person's
 * preferences mute it.
 *
 * Its external effects — the push and the `notify` event on the live streams
 * and in the replay log — are store.afterCommit effects: inside a unit they
 * wait for its COMMIT and are dropped with its rollback; outside one the row
 * is already committed and they run at once. A provider error after COMMIT is
 * a delivery failure, counted by the store, never a rollback.
 */
function notify(audience, type, text, refId = null, { actionRequired = null } = {}) {
  // A category the person has turned off is never CREATED — not
  // created and hidden, not created and un-pushed. The mandatory
  // security_account category cannot be turned off, so it never lands here.
  if (!notificationAllows(audience, type, text)) {
    notificationsSuppressed.count += 1;
    return null;
  }
  // Cut at a character boundary: never half of an emoji's surrogate pair.
  const cut = (t, n) => { let s = t.slice(0, n); if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1); return s; };
  const body = typeof text === 'string' && text.length > NOTIFICATION_LIMITS.text ? `${cut(text, NOTIFICATION_LIMITS.text - 1)}…` : text;
  // Coalesce identical unread notifications. The same sentence about the same
  // record arriving twice is not two pieces of news: it would push the recipient's
  // phone twice and bury the twenty other rows in their bell. So an existing
  // unread row whose last occurrence was within six hours is refreshed and
  // counted rather than duplicated — and no second push is sent. Once the
  // recipient has READ it, a new occurrence is genuinely new and gets its own
  // row. The refreshed row keeps its position in the feed.
  const at = Date.now();
  // The event the feed listeners get; minimised through the registry NOW (a
  // bad call site fails here, inside the unit if there is one), delivered
  // after the commit.
  const announce = () => {
    const { payload, dropped, unregistered } = minimizePayload('notify', { audienceKind: audience.kind, audienceId: audience.id });
    if (unregistered || dropped.length) { eventPayloadDrops.count += 1; eventPayloadDrops.lastEvent = 'notify'; throw new Error(`notify: the 'notify' event ${unregistered ? 'is not in the event registry' : `carried unregistered payload keys: ${dropped.join(', ')}`}`); }
    store.afterCommit(() => publishEvent('notify', payload));
  };
  const existing = notifications.findCoalescible({ audience, type, text: body, refId, at });
  if (existing) {
    const c = notifications.coalesce(existing.id, { at, actionRequired });
    announce();
    return c;
  }

  // `groupKey` (worked out from type and refId) lets any reader fold
  // several DIFFERENT updates about the same record into "3 changes in …"
  // rather than three rows, without the server deciding presentation.
  // `category` is what the preference gate matched.
  const n = notifications.create({
    audience, type, text: body, refId, at, actionRequired,
    category: m182Ctx?.notificationCategoryOf?.(type, body) ?? null,
    deferredPush: pushDeferred(audience),
  });
  // Push delivery honours quiet hours / school-hours mute; the in-app feed
  // above always keeps the record either way. The promise is RETURNED so the
  // store observes it: a rejected delivery is counted and logged instead of
  // becoming an unhandled rejection, and is never mistaken for a rollback.
  if (!n.deferredPush) store.afterCommit(() => pushSender.send(audience, 'ScoutBox', body));
  announce();
  return n;
}

function notificationsFor(kind, id) {
  // Each row is decorated at READ time with the current,
  // authorized resource its refId points to (or null). Nothing is stored.
  // The feed is the repository's (newest insertion first), each row an allowlist.
  const resolve = journeyCtx?.notificationTargetFor;
  return notifications.forAudience(kind, id)
    .map((n) => (resolve ? { ...feedItem(n), target: resolve(n, { kind, id }) } : feedItem(n)));
}

function markNotificationsRead(kind, id) {
  notifications.markRead(kind, id);
}

// ---------------------------------------------------------------- channels
// A channel is the ONLY conversation surface, and it exists solely because a
// request was accepted. For minors the counterparty is the guardian — the
// child is never in the thread. Every message is moderated and logged.
// The thread is a row of the `channels` table (repositories/channels.mjs), written
// at once inside the acceptance route's unit of work with the request's answer.
// The repository refuses a second thread for one request and a request,
// organisation or guardian that does not exist; it returns the stored thread.
// Names have no limit at signup: a thread keeps them shortened, never refused.
const threadName = (v) => (typeof v === 'string' ? v.slice(0, MESSAGE_LIMITS.name) : v);
function openChannel(request) {
  const channel = {
    id: nextId('chan'),
    requestId: request.id,
    playerId: request.playerId,
    playerName: threadName(request.playerName),
    orgId: request.orgId,
    orgName: threadName(request.orgName),
    orgVerified: request.orgVerified,
    scoutName: threadName(request.scoutName),
    scoutRole: threadName(request.scoutRole),
    counterparty: request.routedTo, // 'player' | 'guardian'
    guardianId: request.guardianId,
    createdAt: Date.now(),
    messages: [],
    // Read receipts: last time each side opened the thread.
    readBy: { org: null, counterparty: null },
  };
  return channels.open(channel);
}

// Resolve a message attachment reference into a safe, shareable summary.
function buildAttachment(channel, body, senderSide) {
  const { attachMediaId, attachTrialReportId } = body || {};
  if (!attachMediaId && !attachTrialReportId) return { ok: true, attachment: null };
  const player = findPlayer(channel.playerId);
  if (attachMediaId) {
    const m = player?.media.find((x) => x.id === attachMediaId);
    if (!m) return { ok: false, error: 'MEDIA_NOT_FOUND' };
    return { ok: true, attachment: { kind: 'clip', mediaId: m.id, title: m.title, url: m.url, verifiedClip: !!m.verifiedClip } };
  }
  const r = player?.trialReports.find((x) => x.id === attachTrialReportId && (senderSide !== 'org' || x.orgId === channel.orgId));
  if (!r) return { ok: false, error: 'TRIAL_REPORT_NOT_FOUND' };
  return {
    ok: true,
    attachment: {
      kind: 'trial_report', reportId: r.id, orgName: r.orgName,
      summary: `accel ${r.acceleration}/10 · ${r.sprintSpeedKmh} km/h · ${r.distanceKm} km · pass ${r.passCompletionPct}% · duels ${r.duelSuccessPct}% · coach ${r.coachRating}/10`,
    },
  };
}

/**
 * A message route's text and retry id, checked before moderation: `{ text, clientMsgId }`, or null once a 400 has
 * been sent. Junk is refused, never cut down.
 */
function messageInput(req, res) {
  const { text, clientMsgId = null } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) { res.status(400).json({ error: 'TEXT_REQUIRED' }); return null; }
  if (text.trim().length > MESSAGE_LIMITS.text) { fieldInvalid(res, 'text', `A message is at most ${MESSAGE_LIMITS.text} characters.`); return null; }
  if (clientMsgId !== null && clientMsgId !== '' && (typeof clientMsgId !== 'string' || clientMsgId.length > MESSAGE_LIMITS.clientMsgId)) { fieldInvalid(res, 'clientMsgId', `clientMsgId is text of at most ${MESSAGE_LIMITS.clientMsgId} characters.`); return null; }
  return { text: text.trim(), clientMsgId: clientMsgId || null };
}

function postMessage(channel, rawSender, text, attachment = null, clientMsgId = null) {
  const sender = { ...rawSender, name: threadName(rawSender.name) };
  // Idempotency: a retried send with the same client id returns the message
  // that already landed instead of duplicating it.
  const dup = clientMsgId ? channels.byClientMsgId(channel.id, sender, clientMsgId) : null;
  if (dup) return messageView(dup);
  // One unit: the message (and its attachment), its ledger row and its
  // notifications commit together, before the sender hears 201.
  const msg = unit(() => {
    const stored = channels.appendMessage(channel.id, { id: nextId('msg'), ts: Date.now(), sender, text, attachment, ...(clientMsgId ? { clientMsgId } : {}) });
    ledgerAppend({ type: 'message', playerId: channel.playerId, orgId: channel.orgId, orgName: channel.orgName, userId: sender.kind === 'org_user' ? sender.id : null, scoutName: sender.name });
    // The counterparty an org user's message notifies (a player's or guardian's message notifies the org users below).
    const recipient = channel.counterparty === 'guardian'
      ? { kind: 'guardian', id: channel.guardianId }
      : { kind: 'player', id: channel.playerId };
    if (sender.kind !== 'org_user') {
      // notify every org user who has messaged or created the request
      const userIds = new Set(channels.staffSenders(channel.id));
      const req = recruitment.requests.byId(channel.requestId);
      if (req) userIds.add(req.userId);
      for (const uid of userIds) {
        if (uid) notify({ kind: 'org_user', id: uid }, 'message', `${sender.name} replied in the ${channel.playerName} thread.`, channel.id);
      }
    } else if (recipient.id) {
      notify(recipient, 'message', `${channel.orgName} (${channel.scoutRole}) sent a message.`, channel.id);
    }
    return stored;
  });
  broadcast('messages', { channelId: channel.id });
  return messageView(msg);
}

// The thread a route names, if it is the caller's: the organisation's, the guardian's, or an adult player's own.
const orgThread = (req) => { const c = channels.byId(req.params.id); return c && c.orgId === req.org.id ? c : null; };
const guardianThread = (req) => { const c = channels.byId(req.params.id); return c && c.guardianId === req.guardian.id ? c : null; };
const playerThread = (req) => { const c = channels.byId(req.params.id); return c && c.playerId === req.player.id && c.counterparty === 'player' ? c : null; };

// Re-check a channel's standing on every use. A block, a suspension, or a
// player leaving the org's platform (level or radius change) closes the
// communication path; the history stays as audit but nothing new moves.
function channelClosedForOrg(channel, org) {
  const p = findPlayer(channel.playerId);
  if (!p) return { error: 'CHANNEL_CLOSED', message: 'This player account no longer exists.' };
  if (isBlocked(p.id, org.id)) return { error: 'BLOCKED', message: 'This player (or their guardian) has blocked your organisation.' };
  if (!visibleToOrg(p, org)) return { error: 'CHANNEL_CLOSED', message: 'This player is no longer available to your organisation — the thread is closed (history retained for audit).' };
  return null;
}

function channelClosedForCounterparty(channel, playerId) {
  const org = byId.org(channel.orgId);
  if (!org) return { error: 'CHANNEL_CLOSED', message: 'This organisation no longer exists.' };
  if (org.suspended) return { error: 'ORG_SUSPENDED', message: 'This organisation is suspended pending a safety review — the thread is paused.' };
  if (isBlocked(playerId, org.id)) return { error: 'BLOCKED', message: 'You have blocked this organisation. Lift the block to continue the conversation.' };
  return null;
}

// Channel view without internal ids the caller shouldn't hold (an allowlist: the organisation's id only for the
// organisation itself, the guardian's id never).
const attachmentView = (a) => (a === null ? null : a.kind === 'clip'
  ? { kind: 'clip', mediaId: a.mediaId, title: a.title, url: a.url, verifiedClip: a.verifiedClip }
  : { kind: 'trial_report', reportId: a.reportId, orgName: a.orgName, summary: a.summary });
function messageView(m) {
  return { id: m.id, ts: m.ts, sender: { kind: m.sender.kind, id: m.sender.id, name: m.sender.name }, text: m.text, attachment: attachmentView(m.attachment), ...(m.clientMsgId !== undefined ? { clientMsgId: m.clientMsgId } : {}) };
}
function channelViewFor(c, viewer) {
  return {
    id: c.id, requestId: c.requestId, playerId: c.playerId, playerName: c.playerName,
    ...(viewer === 'org' ? { orgId: c.orgId } : {}),
    orgName: c.orgName, orgVerified: c.orgVerified, scoutName: c.scoutName, scoutRole: c.scoutRole, counterparty: c.counterparty,
    createdAt: c.createdAt, lastActivityAt: c.lastActivityAt, messages: c.messages.map(messageView),
    readBy: { org: c.readBy.org, counterparty: c.readBy.counterparty },
  };
}

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

// ------------------------------------------------------------- player auth
// Real sessions: signup/login/pair mint a bearer token. New accounts require
// a password (scrypt-hashed); seed identities carry no password and stay
// open as demo logins — production seeds always set one.

// Self sign-up is adults only. Under-18 accounts are OWNED by a verified
// guardian and can only be created through the guardian flow below — the API
// itself refuses a minor self-signup.
/**
 * The profile fields a sign-up or a guardian's child creation may carry, refused by name (400 FIELD_INVALID)
 * instead of stored or coerced: the name 1–120 characters, the country and city text, the position and foot from
 * their vocabularies, height and weight whole numbers in range, the coordinates numbers in range.
 */
function profileFieldRefused(res, body) {
  const bad = (field, message) => { res.status(400).json({ error: 'FIELD_INVALID', field, message }); return true; };
  const absent = (v) => v === undefined || v === null || v === '';
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > IDENTITY_LIMITS.name) return bad('name', `name must be text of 1 to ${IDENTITY_LIMITS.name} characters.`);
  if (body.country !== undefined && !(typeof body.country === 'string' && body.country.length >= 1 && body.country.length <= IDENTITY_LIMITS.country)) return bad('country', `country must be text of 1 to ${IDENTITY_LIMITS.country} characters.`);
  if (!absent(body.city) && !(typeof body.city === 'string' && body.city.length <= IDENTITY_LIMITS.city)) return bad('city', `city must be text of at most ${IDENTITY_LIMITS.city} characters.`);
  if (!absent(body.position) && !PLAYER_POSITIONS.includes(body.position)) return bad('position', `position must be one of ${PLAYER_POSITIONS.join(', ')}.`);
  if (!absent(body.foot) && !PLAYER_FEET.includes(body.foot)) return bad('foot', `foot must be one of ${PLAYER_FEET.join(', ')}.`);
  for (const f of ['heightCm', 'weightKg']) {
    const [lo, hi] = IDENTITY_LIMITS[f];
    if (!absent(body[f]) && !(Number.isSafeInteger(body[f]) && body[f] >= lo && body[f] <= hi)) return bad(f, `${f} must be a whole number from ${lo} to ${hi}.`);
  }
  for (const [f, lim] of [['lat', 90], ['lng', 180]]) if (!absent(body[f]) && !(typeof body[f] === 'number' && Number.isFinite(body[f]) && Math.abs(body[f]) <= lim)) return bad(f, `${f} must be a number from -${lim} to ${lim}.`);
  return false;
}
const optional = (v) => (v === undefined || v === null || v === '' ? null : v);

app.post('/auth/player/signup', (req, res) => {
  const { name, dob, country = 'GB', position, foot, password } = req.body || {};
  if (!name || !dob) return res.status(400).json({ error: 'NAME_AND_DOB_REQUIRED' });
  if (profileFieldRefused(res, req.body)) return;
  // A date of birth that cannot be READ is refused here, not stored: it would
  // fail closed as "age unknown", but the account's age could then never be
  // established. A real day, not in the future, not implausibly old.
  if (!parseDobStrict(dob, Date.now()).ok) return res.status(400).json({ error: 'DOB_INVALID', message: 'Enter a date of birth as YYYY-MM-DD.' });
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'PASSWORD_REQUIRED', message: 'Pick a password of at least 8 characters — your profile is yours alone.' });
  }
  const required = adultAgeFor(country);
  if (ageOn(dob) < required) {
    return res.status(403).json({
      error: 'GUARDIAN_REQUIRED',
      message: `Under-${required} profiles are owned by a parent or guardian. A guardian must verify their ID, accept the safeguarding disclaimer, and create the profile from their own account.`,
    });
  }
  const p = {
    id: nextId('pl'),
    name,
    dob,
    country,
    city: optional(req.body.city),
    position: optional(position),
    foot: optional(foot),
    heightCm: optional(req.body.heightCm),
    weightKg: optional(req.body.weightKg),
    createdAt: Date.now(),
    passwordHash: hashPassword(password),
    // Optional coordinates: without them the player simply is not visible to
    // grassroots clubs (the radius rule fails closed, never open).
    location: typeof req.body.lat === 'number' && typeof req.body.lng === 'number'
      ? { lat: req.body.lat, lng: req.body.lng } : null,
  };

  // One unit of work: the player row, the saved-search notifications and the
  // session; the broadcast and any push go out after COMMIT.
  let created; let token;
  try {
    unit(() => {
      created = players.create(p);
      checkSavedSearches(created);
      token = createSession('player', created.id);
      broadcast('players');
    });
  } catch (e) {
    if (e?.code === 'PLAYER_RECORD_INVALID') return res.status(400).json({ error: 'PLAYER_INVALID', message: String(e.message) });
    throw e;
  }
  res.status(201).json({ playerId: created.id, player: JSON.parse(JSON.stringify(created)), token });
});

app.post('/auth/player/login', (req, res) => {
  // Lockout first — before the lookup, so an unknown id and a real one
  // are refused identically once the budget is gone.
  if (loginLockedOut(res, `player:${req.body?.playerId}`)) return;
  const p = findPlayer(req.body?.playerId);
  if (!p) { noteLoginFailure(`player:${req.body?.playerId}`); return res.status(404).json({ error: 'PLAYER_NOT_FOUND' }); }
  const hash = players.passwordHashOf(p.id);
  if (hash) {
    const check = verifyPassword(req.body?.password ?? '', hash);
    if (!check) { noteLoginFailure(`player:${p.id}`); return res.status(401).json({ error: 'BAD_PASSWORD', message: 'This profile is password-protected.' }); }
    if (check === 'upgrade') players.setPasswordHash(p.id, hashPassword(req.body.password)); // upgrade a plain-text record to scrypt
  } else if (!DEV_LOGINS) {
    return devLoginRefused(res);
  }
  res.json({ playerId: p.id, name: p.name, token: createSession('player', p.id) });
});

function playerAuth(req, res, next) {
  const session = sessionFor(req);
  const p = session?.kind === 'player' ? findPlayer(session.refId) : null;
  if (!p) return res.status(401).json({ error: 'PLAYER_AUTH_REQUIRED', message: 'Log in again — this session is no longer valid.' });
  req.player = p;
  req.playerIsMinor = !isAdult(p);
  next();
}

// Refuses guardian-managed actions on a child account. Parents manage all
// messages, notifications and club interactions; the child keeps football
// activities (uploads, stats, drills, attendance).
function guardianManagedOnly(req, res) {
  if (req.playerIsMinor) {
    res.status(403).json({
      error: 'GUARDIAN_MANAGED',
      message: 'This setting is managed by your parent or guardian.',
    });
    return true;
  }
  return false;
}

// -------------------------------------------------------------- guardians
// Parents own every under-18 account. The account and its safeguarding gates (e-mail, ID, disclaimer) are
// domains/identity/guardians.mjs; the child-management routes below mount on its router.
const { guardianRouter } = registerGuardianAccount({
  app, guardians, safetyAudit, unit, nextId, mailer, idv, faultSeam: seam,
  createSession, sessionFor, loginKey, loginLockedOut, noteLoginFailure, devLogins: DEV_LOGINS, devLoginRefused,
});

guardianRouter.get('/children', (req, res) => {
  res.json(
    req.guardian.childIds
      .map((id) => findPlayer(id))
      .filter(Boolean)
      .map((p) => guardianChildView(p, VIEW_HELPERS))
  );
});

// Creating a child profile requires BOTH gates: verified ID + accepted disclaimer.
guardianRouter.post('/children', (req, res) => {
  if (req.guardian.emailVerified === false) {
    return res.status(403).json({ error: 'EMAIL_UNVERIFIED', message: 'Verify your email address first — the code is in your inbox.' });
  }
  if (!req.guardian.idVerified) {
    return res.status(403).json({ error: 'GUARDIAN_ID_UNVERIFIED', message: 'Verify your identity before onboarding a child.' });
  }
  if (!req.guardian.disclaimerAccepted) {
    return res.status(403).json({ error: 'DISCLAIMER_REQUIRED', message: 'Accept the safeguarding disclaimer before onboarding a child.' });
  }
  const { name, dob, country = 'GB', position, foot, heightCm, weightKg } = req.body || {};
  if (!name || !dob) return res.status(400).json({ error: 'NAME_AND_DOB_REQUIRED' });
  if (profileFieldRefused(res, req.body)) return;
  // A date of birth that cannot be READ is refused here, not stored: it would
  // fail closed as "age unknown", but the account's age could then never be
  // established. A real day, not in the future, not implausibly old.
  if (!parseDobStrict(dob, Date.now()).ok) return res.status(400).json({ error: 'DOB_INVALID', message: 'Enter a date of birth as YYYY-MM-DD.' });
  if (ageOn(dob) >= adultAgeFor(country)) {
    return res.status(400).json({ error: 'NOT_A_MINOR', message: 'Adults create their own account with player sign-up.' });
  }
  const p = {
    id: nextId('pl'),
    name,
    dob,
    country,
    guardianId: req.guardian.id,
    position: optional(position),
    foot: optional(foot),
    heightCm: optional(heightCm),
    weightKg: optional(weightKg),
    createdAt: Date.now(),
    location: typeof req.body.lat === 'number' && typeof req.body.lng === 'number'
      ? { lat: req.body.lat, lng: req.body.lng } : null,
  };

  // One unit of work: the child row and its primary link (the guardian's
  // childIds follow from the link), the saved-search notifications; the
  // broadcast and any push go out after COMMIT.
  let child;
  try {
    unit(() => {
      child = players.create(p);
      checkSavedSearches(child);
      broadcast('players');
    });
  } catch (e) {
    if (e?.code === 'PLAYER_RECORD_INVALID') return res.status(400).json({ error: 'PLAYER_INVALID', message: String(e.message) });
    throw e;
  }
  res.status(201).json({ playerId: child.id, player: guardianChildView(child, VIEW_HELPERS) });
});

// Scout Inbox for minors lives with the GUARDIAN. Club-first identity:
// the parent sees the verified club and the sender's verified role.
// Newest first, paged by cursor: { items, nextCursor }.
guardianRouter.get('/inbox', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const { items, nextCursor } = recruitment.requests.pageForGuardianOf(req.guardian.childIds, page);
  res.json({ items: items.map(requestForRecipient), nextCursor });
});

guardianRouter.post('/requests/:id/respond', (req, res) => {
  const candidate = recruitment.requests.byId(req.params.id);
  const found = candidate && candidate.routedTo === 'guardian' && req.guardian.childIds.includes(candidate.playerId) ? candidate : null;
  if (!found) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  if (found.status !== 'pending') return res.status(409).json({ error: 'ALREADY_RESPONDED' });
  const child = findPlayer(found.playerId);
  const { accept, chosenSlot } = req.body || {};
  const replyCheck = contactReplyFrom(req, res, found);
  if (!replyCheck.ok) return;
  // A block the guardian placed AFTER the request arrived: they may still
  // decline it, but accepting would open a thread with an organisation they
  // blocked, so that is refused.
  if (accept && isBlocked(found.playerId, found.orgId)) {
    return res.status(403).json({ error: 'BLOCKED', message: 'You have blocked this organisation. Lift the block before accepting.' });
  }
  if (found.contactId && rateLimit.limited('contact_response', `guardian:${req.guardian.id}`)) return res.status(429).json(rateLimitedBody('contact_response'));
  // The slot is checked BEFORE the answer is recorded, so a refused
  // slot leaves the request pending rather than accepted-with-the-wrong-day.
  const slot = accept && found.type === 'trial' ? chooseTrialSlot(found.trialDetails, chosenSlot) : { ok: true, date: null };
  if (!slot.ok) return res.status(400).json(slot);
  // A Trial invitation tied to a recruitment case re-derives its recipient
  // NOW — the guardian must still be this child's verified route, the club
  // must still be allowed to reach the child. Requests with no caseId keep
  // the request's own rule.
  if (accept && found.type === 'trial' && found.caseId && lifecycleDomain?.trialAcceptGate) {
    const gate = lifecycleDomain.trialAcceptGate({ request: found, by: 'guardian', actorId: req.guardian.id });
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error, message: gate.message });
  }
  const respondedAt = Date.now();
  // One unit of work: the answer, the Contact, the channel and the trial
  // commit together or not at all.
  const answered = unit(() => {
  // The record the hooks see is the stored one.
  let request = recruitment.requests.recordResponse(found.id, { status: accept ? 'accepted' : 'declined', respondedAt, respondedBy: 'guardian' });
  // The Contact that created this request learns of the answer.
  lifecycleDomain?.onRequestResponded?.({ request, accept: !!accept, message: replyCheck.reply, by: 'guardian', at: respondedAt });
  // The answer, the channel and the trial row are ONE unit,
  // so a crash between them cannot leave an accepted request with no trial.

  if (accept) {
    // The conversation that opens is between adults: club staff and guardian.
    const channel = openChannel(request);
    request = recruitment.requests.attachChannel(request.id, { channelId: channel.id });
    ledgerAppend({ type: `${request.type}_accepted_by_guardian`, playerId: child.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    if (request.type === 'trial') {
      const trial = issueAcceptedTrial({ request, player: child, trialDate: slot.date, by: 'guardian', at: respondedAt, actor: { id: req.guardian.id, name: req.guardian.name } });
      // The case learns of the acceptance through the Trial hook — a concrete
      // slot confirms the schedule and moves the case through the single
      // lifecycle writer, in the same unit as the answer.
      lifecycleDomain?.onTrialAccepted?.({ request, trial, at: respondedAt, actor: { kind: 'guardian', id: req.guardian.id, name: req.guardian.name } });
    }
    notify({ kind: 'org_user', id: request.userId }, 'accepted', `The guardian of ${child.name} accepted your ${request.type} request — thread open.`, request.contactChannel);
    // The child hears the outcome as a request outcome ("Messages and
    // requests"), the same category the club's own accepted/declined rows
    // use — not as a discovery nudge, which is off by default.
    notify({ kind: 'player', id: child.id }, 'guardian_decision', `Your parent/guardian accepted the ${request.type} with ${request.orgName}.`, request.id);
  } else {
    ledgerAppend({ type: `${request.type}_declined_by_guardian`, playerId: child.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    if (request.type === 'trial') lifecycleDomain?.onTrialDeclined?.({ request, at: respondedAt, actor: { kind: 'guardian', id: req.guardian.id, name: req.guardian.name }, message: replyCheck.reply });
    notify({ kind: 'org_user', id: request.userId }, 'declined', `The guardian of ${child.name} declined your ${request.type} request.`, request.id);
    notify({ kind: 'player', id: child.id }, 'guardian_decision', `Your parent/guardian declined the ${request.type} with ${request.orgName}.`, request.id);
  }
  broadcast('requests', { playerId: child.id });
  return recruitment.requests.byId(request.id);
  });
  res.json(requestForRecipient(answered));
});

// Guardian-side message threads (adult-to-adult, moderated, logged).
guardianRouter.get('/channels', (req, res) => {
  res.json(channels.forGuardian(req.guardian.id).map((c) => channelViewFor(c, 'guardian')));
});

guardianRouter.post('/channels/:id/messages', (req, res) => {
  const channel = guardianThread(req);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  const closed = channelClosedForCounterparty(channel, channel.playerId);
  if (closed) return res.status(403).json(closed);
  const input = messageInput(req, res); if (!input) return;
  if (!moderateOrRefuse(res, input.text, { kind: 'guardian_message', channelId: channel.id })) return;
  const att = buildAttachment(channel, req.body, 'guardian');
  if (!att.ok) return res.status(400).json({ error: att.error });
  res.status(201).json(postMessage(channel, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name }, input.text, att.attachment, input.clientMsgId));
});

guardianRouter.post('/channels/:id/read', (req, res) => {
  const channel = guardianThread(req);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  const readBy = channels.markRead(channel.id, 'counterparty', Date.now());
  broadcast('messages', { channelId: channel.id });
  res.json({ readBy: { org: readBy.org, counterparty: readBy.counterparty } });
});

guardianRouter.post('/channels/:id/typing', (req, res) => {
  const channel = guardianThread(req);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  broadcast('typing', { channelId: channel.id, side: 'counterparty' });
  res.json({ ok: true });
});

// The weekly parent digest: everything that happened around your children.
guardianRouter.get('/digest', (req, res) => {
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const children = req.guardian.childIds.map((id) => findPlayer(id)).filter(Boolean);
  res.json({
    generatedAt: new Date().toISOString(),
    children: children.map((c) => {
      const ins = insightsFor(c.id);
      return {
        id: c.id,
        name: c.name,
        views: ins.thisWeek.views,
        shortlists: ins.thisWeek.shortlists,
        streak: computeStreak(c.activityLog),
        weeklyGoal: weeklyGoal(c.activityLog),
        newRequests: recruitment.requests.forPlayer(c.id).filter((r) => r.createdAt >= week).length,
        activityThisWeek: (c.activityLog ?? []).filter((ts) => ts >= week).length,
      };
    }),
    note: 'Only verified clubs can see your children, and every action above is on the ledger.',
  });
});

// Guardian sets the child's availability ("open to trials" etc.) —
// club interaction is the parent's call, so this control lives here.
guardianRouter.post('/children/:id/availability', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  const AV = ['available_now', 'end_of_season', 'not_seeking'];
  const { availability } = req.body || {};
  if (!AV.includes(availability)) return res.status(400).json({ error: 'BAD_AVAILABILITY', allowed: AV });
  const stored = players.update(child.id, (d) => { d.availability = availability; });
  broadcast('players', { playerId: child.id });
  res.json({ availability: stored.availability });
});

// Co-guardian: a second parent/guardian sharing the same children.
guardianRouter.post('/coguardian', (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'NAME_AND_EMAIL_REQUIRED' });
  if (!reqText(name, IDENTITY_LIMITS.name)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'name', message: `name must be text of 1 to ${IDENTITY_LIMITS.name} characters.` });
  if (!reqText(email, IDENTITY_LIMITS.email) || !email.includes('@')) return res.status(400).json({ error: 'FIELD_INVALID', field: 'email', message: 'email must be an e-mail address.' });
  const co = {
    id: nextId('gd'),
    name,
    email,
    idVerified: false, // must still verify + accept before acting
    disclaimerAccepted: false,
    childIds: [...req.guardian.childIds],
    coGuardianOf: req.guardian.id,
    createdAt: Date.now(),
  };
  // One unit: the co-guardian's row and its co links (one per child). The primary's coGuardians list is worked out
  // from the co-guardians' coGuardianOf.
  try {
    guardians.create(co);
  } catch (e) {
    if (e?.code === 'EMAIL_IN_USE') return res.status(409).json({ error: 'EMAIL_IN_USE', message: 'A guardian account with this email already exists.' });
    if (e?.code === 'GUARDIAN_RECORD_INVALID') return res.status(400).json({ error: 'GUARDIAN_INVALID', message: String(e.message) });
    throw e;
  }
  res.status(201).json({ guardianId: co.id, note: 'The co-guardian must verify their ID and accept the disclaimer before they can act.' });
});

guardianRouter.get('/notifications', (req, res) => res.json(notificationsFor('guardian', req.guardian.id)));
guardianRouter.post('/notifications/read', (req, res) => {
  markNotificationsRead('guardian', req.guardian.id);
  res.json({ ok: true });
});

guardianRouter.get('/reports', (req, res) => {
  res.json(safetyAudit.reports.forReporter('guardian', req.guardian.id).map(filedReportView));
});

guardianRouter.get('/children/:id/insights', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  res.json(insightsFor(child.id));
});

// All communications are logged, and the parent can read the full log.
// Newest first, paged by cursor (domains/platform/paging.mjs): { items, nextCursor }.
guardianRouter.get('/log', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const out = safetyAudit.ledger.pageForPlayers(req.guardian.childIds, page);
  res.json({ items: out.items.map(ledgerView), nextCursor: out.nextCursor });
});

// Guardian controls the child's medical sharing and availability.
guardianRouter.post('/children/:id/medical/share', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  if (switchRefused(res, req.body?.shared, 'shared')) return;
  const stored = players.update(child.id, (d) => { d.medical.shared = req.body.shared; });
  broadcast('players', { playerId: child.id });
  res.json({ shared: stored.medical.shared });
});

guardianRouter.post('/report', (req, res) => handleReport(req, res, { by: 'guardian', byId: req.guardian.id }));
guardianRouter.post('/block', (req, res) => {
  const { orgId, playerId, reason } = req.body || {};
  // A block lands on the child it names. A playerId that is
  // not this guardian's child is refused, never silently swapped for the first
  // child; with no playerId, a guardian of exactly one child means that child.
  if (playerId && !req.guardian.childIds.includes(playerId)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  const childId = playerId || (req.guardian.childIds.length === 1 ? req.guardian.childIds[0] : null);
  if (!orgId || !childId) return res.status(400).json({ error: 'ORG_AND_CHILD_REQUIRED', message: playerId ? undefined : 'Name which child the block is for (playerId).' });
  if (!optText(reason)) return badField(res, 'reason');
  if (!byId.org(orgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
  unit(() => {
    safetyAudit.blocks.add({ id: nextId('blk'), playerId: childId, orgId, by: 'guardian', reason: reason || '', ts: Date.now() });
    ledgerAppend({ type: 'org_blocked_by_guardian', playerId: childId, orgId, orgName: byId.org(orgId).name, userId: null, scoutName: 'guardian' });
  });
  broadcast('players');
  res.status(201).json({ blocked: true });
});

// One-click reporting, shared by guardian / player / org callers.
// An urgent report immediately suspends communication pending review.
function handleReport(req, res, actor) {
  const { targetKind, targetOrgId, targetScoutName, targetPlayerId, reason, urgent } = req.body || {};
  if (!['club', 'scout', 'player'].includes(targetKind)) {
    return res.status(400).json({ error: 'TARGET_KIND_REQUIRED', allowed: ['club', 'scout', 'player'] });
  }
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
  if (typeof reason !== 'string' || reason.trim().length > AUDIT_LIMITS.reason) return badField(res, 'reason');
  // The report's references are text columns: an id of another type is refused, never stored.
  for (const [field, v] of [['targetOrgId', targetOrgId], ['targetScoutName', targetScoutName], ['targetPlayerId', targetPlayerId]]) if (!optText(v, 200)) return badField(res, field);
  if (targetOrgId && !byId.org(targetOrgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
  const report = {
    id: nextId('rep'),
    ts: Date.now(),
    byOrgId: null,
    ...actor,
    targetKind,
    targetOrgId: targetOrgId || null,
    targetScoutName: targetScoutName || null,
    targetPlayerId: targetPlayerId || null,
    reason: String(reason).trim(),
    urgent: !!urgent,
    status: 'pending_review',
    outcome: null,
    resolvedAt: null,
  };
  // Reports land in the REAL review queue: the trust-and-safety admin
  // console resolves them (POST /admin/reports/:id/resolve) and the reporter
  // is notified with the outcome. The targetPlayerId is not checked against
  // the players (Q4). An urgent report against an organisation suspends it
  // at once, in the same unit: the org loses access to the reporter's players
  // and its pending requests to them freeze.
  const suspend = !!(report.urgent && targetOrgId);
  const playerIds = !suspend ? [] : actor.by === 'guardian'
    ? byId.guardian(actor.byId)?.childIds ?? []
    : actor.by === 'player' ? [actor.byId] : [];
  unit(() => {
    safetyAudit.reports.file(report);
    for (const pid of playerIds) {
      safetyAudit.blocks.add({ id: nextId('blk'), playerId: pid, orgId: targetOrgId, by: actor.by, reason: 'suspended_pending_review', ts: Date.now() });
      for (const r of recruitment.requests.forOrgPlayer(targetOrgId, pid).filter((x) => x.status === 'pending')) {
        recruitment.requests.suspend(r.id); // the frozen request, with its block
      }
    }
  });
  if (suspend) broadcast('players');
  res.status(201).json({ reportId: report.id, status: report.status, suspended: !!(report.urgent && targetOrgId) });
}

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

const orgRouter = express.Router();
app.use('/org', orgAuth, orgRouter);

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

// One-click reporting for org users too (report a player, scout or club).
orgRouter.post('/report', (req, res) => handleReport(req, res, { by: 'org_user', byId: req.orgUser.id, byOrgId: req.org.id }));

orgRouter.get('/reports', (req, res) => {
  res.json(safetyAudit.reports.forReporter('org_user', req.orgUser.id).map(filedReportView));
});

// Message threads for this org — only exist where a request was accepted. Pages by cursor, most recently active
// first; `playerId` limits the page to one player's threads (a Room's inbox panel).
orgRouter.get('/channels', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number', 'number']); } catch (e) { return sendPageError(res, e); }
  const { playerId } = req.query;
  if (playerId !== undefined && (typeof playerId !== 'string' || !playerId || playerId.length > MESSAGE_LIMITS.id)) return fieldInvalid(res, 'playerId', 'playerId is the id of a player, as text.');
  const out = channels.pageForOrg(req.org.id, { playerId: playerId ?? null }, page);
  res.json({ items: out.items.map((c) => ({ ...channelViewFor(c, 'org'), closed: !!channelClosedForOrg(c, req.org) })), nextCursor: out.nextCursor });
});

// The inbox figures the home screens show: the organisation's threads and the messages from players and guardians
// since the club last opened each thread.
orgRouter.get('/channels/counts', (req, res) => res.json(channels.countsForOrg(req.org.id)));

orgRouter.post('/channels/:id/messages', (req, res) => {
  const channel = orgThread(req);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  // Eligibility is rechecked on every send, not just when the channel opened.
  const closed = channelClosedForOrg(channel, req.org);
  if (closed) return res.status(403).json(closed);
  const input = messageInput(req, res); if (!input) return;
  if (!moderateOrRefuse(res, input.text, { kind: 'org_message', channelId: channel.id })) return;
  const att = buildAttachment(channel, req.body, 'org');
  if (!att.ok) return res.status(400).json({ error: att.error });
  // postMessage notifies the counterparty (guardian or adult player).
  const msg = postMessage(channel, { kind: 'org_user', id: req.orgUser.id, name: `${req.orgUser.name} · ${req.orgUser.role || 'Scout'} · ${req.org.name}` }, input.text, att.attachment, input.clientMsgId);
  res.status(201).json(msg);
});

orgRouter.post('/channels/:id/read', (req, res) => {
  const channel = orgThread(req);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  const readBy = channels.markRead(channel.id, 'org', Date.now());
  broadcast('messages', { channelId: channel.id });
  res.json({ readBy: { org: readBy.org, counterparty: readBy.counterparty } });
});

orgRouter.post('/channels/:id/typing', (req, res) => {
  const channel = orgThread(req);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  if (channelClosedForOrg(channel, req.org)) return res.status(403).json({ error: 'CHANNEL_CLOSED' });
  broadcast('typing', { channelId: channel.id, side: 'org' });
  res.json({ ok: true });
});

orgRouter.get('/notifications', (req, res) => res.json(notificationsFor('org_user', req.orgUser.id)));
orgRouter.post('/notifications/read', (req, res) => {
  markNotificationsRead('org_user', req.orgUser.id);
  res.json({ ok: true });
});

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
  // every side effect come from the ONE writer (m29Ctx), and a recruitment
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
  const blocker = m29Ctx?.legacyRecordingBlocker?.(p.id, req.org.id, Date.now());
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
  if (!m29Ctx?.recordCompletedSigning) return res.status(500).json({ error: 'SIGNING_STORE_MISSING' });
  // The ledger row, the signings row and the player's level / contract columns commit as one unit of work.
  // Typed input only — a note is text of at most 400 characters, or absent; never sliced.
  const legacyNote = req.body?.note;
  if (legacyNote !== undefined && legacyNote !== null && legacyNote !== '' && (typeof legacyNote !== 'string' || legacyNote.length > 400)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'note', message: 'The note is text of at most 400 characters.' });
  let written;
  try {
    written = unit(() => m29Ctx.recordCompletedSigning({ player: p, org: req.org, actor: req.orgUser, at: Date.now(), legacy: { note: typeof legacyNote === 'string' && legacyNote ? legacyNote : null } }));
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
      if (!other) players.update(p.id, (d) => { d.availability = 'available_now'; d.contractStatus = 'free_agent'; });
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

// ------------------------------------------------------------ player routes
const playerRouter = express.Router();
app.use('/player', playerAuth, playerRouter);

playerRouter.get('/me', (req, res) => {
  const { password, ...safe } = req.player;
  const score = computeTrustScore(req.player);
  res.json({
    ...safe,
    age: ageOn(req.player.dob),
    trustScore: score,
    trust: trustBreakdown(req.player),
    tier: trustTier(score),
    streak: computeStreak(req.player.activityLog),
    weeklyGoal: weeklyGoal(req.player.activityLog),
    nextActions: nextActions(req.player),
    // Aging-up: an adult still linked to a guardian is offered ownership.
    agingUp: isAdult(req.player) && req.player.guardianId ? { eligible: true } : null,
    // The Grassroots journey (null for pro-level players).
    pathway: pathwayFor(req.player, { vouchCount: publishedVouchesFor(req.player.id).length }),
    programme: programmeProgress(req.player),
    vouches: verificationReads.vouches.forPlayer(req.player.id).map(vouchView),
  });
});

// Aging-up transition: the day a guardian-owned player is an adult, ownership
// moves to them — explicit consent, guardian notified, ledger records it.
playerRouter.post('/aging-up/complete', (req, res) => {
  if (!isAdult(req.player)) return res.status(403).json({ error: 'STILL_A_MINOR', message: 'The transition unlocks on your 18th birthday (age of majority in your country).' });
  if (!req.player.guardianId) return res.status(400).json({ error: 'ALREADY_OWNED', message: 'You already own this account.' });
  const guardian = byId.guardian(req.player.guardianId);
  // One unit of work: the primary link goes on both sides (players.ageUp), the
  // timeline entry, the ledger row and the two notifications commit together;
  // the pushes and the broadcast go out after COMMIT.
  unit(() => {
    players.ageUp(req.player.id);
    if (guardian) notify({ kind: 'guardian', id: guardian.id }, 'aging_up', `${req.player.name} is 18 — their account is now their own. Their history stays intact, and thank you for keeping it safe.`, req.player.id);
    players.addItem(req.player.id, 'timeline', { year: String(new Date().getFullYear()), event: 'Turned 18 — took ownership of this ScoutBox account' });
    ledgerAppend({ type: 'account_transitioned', playerId: req.player.id, orgId: null, orgName: 'ScoutBox', userId: null, scoutName: 'system' });
    notify({ kind: 'player', id: req.player.id }, 'aging_up', 'Your account is now fully yours. Availability, medical sharing and club contact are your calls from here.', req.player.id);
    broadcast('players', { playerId: req.player.id });
  });
  res.json({ ok: true, owned: true });
});

// The player-side home feed: weekly scout report first, then activity.
playerRouter.get('/feed', (req, res) => {
  const p = req.player;
  const ins = insightsFor(p.id);
  const topClip = p.media.slice().sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0] ?? null;
  const items = [];
  items.push({
    type: 'weekly_report',
    ts: Date.now(),
    report: {
      views: ins.thisWeek.views,
      shortlists: ins.thisWeek.shortlists,
      streak: computeStreak(p.activityLog),
      weeklyGoal: weeklyGoal(p.activityLog),
      topClip: topClip ? { title: topClip.title, views: topClip.views ?? 0, verified: !!topClip.verifiedClip } : null,
      suggestion: nextActions(p)[0] ?? null,
    },
  });
  for (const e of ins.recent.slice(0, 8)) {
    items.push({ type: 'scouting_event', ts: e.ts, orgName: e.orgName, eventType: e.type });
  }
  const noticed = {};
  for (const m of p.media) for (const [tag, n] of Object.entries(m.tags ?? {})) noticed[tag] = (noticed[tag] ?? 0) + n;
  if (Object.keys(noticed).length) {
    items.push({ type: 'scouts_noticed', ts: Date.now() - 1, tags: noticed });
  }
  res.json(items);
});

// Portable Verified Sports CV — the player owns their record.
playerRouter.get('/cv', (req, res) => {
  const p = req.player;
  const score = computeTrustScore(p);
  res.json({
    generatedAt: new Date().toISOString(),
    player: {
      name: p.name, age: ageOn(p.dob), country: p.country, position: p.position, foot: p.foot,
      heightCm: p.heightCm, weightKg: p.weightKg, identityVerified: p.identityVerified,
    },
    trust: { score, tier: trustTier(score), breakdown: trustBreakdown(p) },
    seasonStats: p.stats,
    verifiedAttendance: p.attendance.map((a) => ({ fixture: a.fixture, venue: a.venue, date: a.date })),
    verifiedClips: p.media.filter((m) => m.verifiedClip).map((m) => ({ title: m.title, uploadedAt: m.uploadedAt })),
    trialReports: p.trialReports.map((r) => ({
      orgName: r.orgName, filedAt: r.filedAt,
      acceleration: r.acceleration, sprintSpeedKmh: r.sprintSpeedKmh, distanceKm: r.distanceKm,
      passCompletionPct: r.passCompletionPct, duelSuccessPct: r.duelSuccessPct, coachRating: r.coachRating,
    })),
    combine: p.drillResults,
    timeline: p.timeline,
    note: 'Generated by ScoutBox. Attendance is GPS+device verified; trial reports are filed by clubs; trust is never purchasable.',
  });
});

// Scout Inbox — org identity is summarised, org ids are stripped; the player
// sees who wants them and decides. No message thread exists until acceptance.
// A CHILD's inbox never carries a message or a contact channel: they see only
// guardian-managed status updates. No direct messages to children. Ever.
// Newest first, paged by cursor: { items, nextCursor }.
playerRouter.get('/inbox', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const { items: rows, nextCursor } = recruitment.requests.pageForPlayer(req.player.id, page);
  if (req.playerIsMinor) {
    return res.json({
      items: rows
        .map((r) => ({
          id: r.id,
          type: r.type,
          orgName: r.orgName,
          orgVerified: r.orgVerified,
          status: r.status,
          guardianManaged: true,
          note:
            r.status === 'pending'
              ? `${r.orgName} contacted your parent/guardian about a ${r.type === 'trial' ? 'trial' : 'conversation'}. They will decide together with you.`
              : r.status === 'accepted'
                ? `Your parent/guardian accepted the ${r.type} with ${r.orgName}.`
                : `Your parent/guardian declined the ${r.type} with ${r.orgName}.`,
        })),
      nextCursor,
    });
  }
  res.json({ items: rows.map(requestForRecipient), nextCursor });
});

playerRouter.post('/requests/:id/respond', (req, res) => {
  if (guardianManagedOnly(req, res)) return; // minors never respond — guardians do
  const found = onlyIf(recruitment.requests.byId(req.params.id), (r) => r.playerId === req.player.id && r.routedTo === 'player');
  if (!found) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  if (found.status !== 'pending') return res.status(409).json({ error: 'ALREADY_RESPONDED' });
  const { accept, chosenSlot } = req.body || {};
  const replyCheck = contactReplyFrom(req, res, found);
  if (!replyCheck.ok) return;
  // Same rule as the guardian route: a blocked organisation can be declined,
  // never accepted.
  if (accept && isBlocked(req.player.id, found.orgId)) {
    return res.status(403).json({ error: 'BLOCKED', message: 'You have blocked this organisation. Lift the block before accepting.' });
  }
  if (found.contactId && rateLimit.limited('contact_response', `player:${req.player.id}`)) return res.status(429).json(rateLimitedBody('contact_response'));
  // Slot checked before the answer is recorded (see the guardian route).
  const slot = accept && found.type === 'trial' ? chooseTrialSlot(found.trialDetails, chosenSlot) : { ok: true, date: null };
  if (!slot.ok) return res.status(400).json(slot);
  // The recipient of a case-tied Trial invitation is re-derived now.
  if (accept && found.type === 'trial' && found.caseId && lifecycleDomain?.trialAcceptGate) {
    const gate = lifecycleDomain.trialAcceptGate({ request: found, by: 'player', actorId: req.player.id });
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error, message: gate.message });
  }
  const respondedAt = Date.now();
  // One unit of work: the answer, the Contact, the channel and the trial
  // commit together or not at all.
  const answered = unit(() => {
  // Both respond paths stamp who answered.
  let request = recruitment.requests.recordResponse(found.id, { status: accept ? 'accepted' : 'declined', respondedAt, respondedBy: 'player' });
  // The Contact that created this request learns of the answer.
  lifecycleDomain?.onRequestResponded?.({ request, accept: !!accept, message: replyCheck.reply, by: 'player', at: respondedAt });

  if (accept) {
    // Only now does a contact channel exist.
    const channel = openChannel(request);
    request = recruitment.requests.attachChannel(request.id, { channelId: channel.id });
    ledgerAppend({ type: `${request.type}_accepted`, playerId: req.player.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    if (request.type === 'trial') {
      const trial = issueAcceptedTrial({ request, player: req.player, trialDate: slot.date, by: 'player', at: respondedAt, actor: { id: req.player.id, name: req.player.name } });
      lifecycleDomain?.onTrialAccepted?.({ request, trial, at: respondedAt, actor: { kind: 'player', id: req.player.id, name: req.player.name } });
    }
    notify({ kind: 'org_user', id: request.userId }, 'accepted', `${req.player.name} accepted your ${request.type} request — thread open.`, request.contactChannel);
  } else {
    ledgerAppend({ type: `${request.type}_declined`, playerId: req.player.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    if (request.type === 'trial') lifecycleDomain?.onTrialDeclined?.({ request, at: respondedAt, actor: { kind: 'player', id: req.player.id, name: req.player.name }, message: replyCheck.reply });
    notify({ kind: 'org_user', id: request.userId }, 'declined', `${req.player.name} declined your ${request.type} request.`, request.id);
  }
  broadcast('requests', { playerId: req.player.id });
  return recruitment.requests.byId(request.id);
  });
  res.json(requestForRecipient(answered));
});

// Adult players talk in their own threads; a child never has one.
playerRouter.get('/channels', (req, res) => {
  if (req.playerIsMinor) return res.json([]); // threads live with the guardian
  res.json(channels.forPlayer(req.player.id, { counterparty: 'player' }).map((c) => channelViewFor(c, 'player')));
});

playerRouter.post('/channels/:id/messages', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  const channel = playerThread(req);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  const closed = channelClosedForCounterparty(channel, req.player.id);
  if (closed) return res.status(403).json(closed);
  const input = messageInput(req, res); if (!input) return;
  if (!moderateOrRefuse(res, input.text, { kind: 'player_message', channelId: channel.id })) return;
  const att = buildAttachment(channel, req.body, 'player');
  if (!att.ok) return res.status(400).json({ error: att.error });
  res.status(201).json(postMessage(channel, { kind: 'player', id: req.player.id, name: req.player.name }, input.text, att.attachment, input.clientMsgId));
});

playerRouter.post('/channels/:id/read', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  const channel = playerThread(req);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  const readBy = channels.markRead(channel.id, 'counterparty', Date.now());
  broadcast('messages', { channelId: channel.id });
  res.json({ readBy: { org: readBy.org, counterparty: readBy.counterparty } });
});

playerRouter.post('/channels/:id/typing', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  const channel = playerThread(req);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  broadcast('typing', { channelId: channel.id, side: 'counterparty' });
  res.json({ ok: true });
});

playerRouter.get('/notifications', (req, res) => res.json(notificationsFor('player', req.player.id)));
playerRouter.post('/notifications/read', (req, res) => {
  markNotificationsRead('player', req.player.id);
  res.json({ ok: true });
});

// "Who's watching you" — the player's side of the Discovery Ledger.
playerRouter.get('/insights', (req, res) => res.json(insightsFor(req.player.id)));

playerRouter.get('/reports', (req, res) => {
  res.json(safetyAudit.reports.forReporter('player', req.player.id).map(filedReportView));
});

// Academy+ is opt-in only and player-controlled (guardian-managed for minors).
playerRouter.post('/academyplus', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  if (switchRefused(res, req.body?.enabled, 'enabled')) return;
  // ONE unit of work: the column and the badge commit together.
  let stored;
  unit(() => {
    stored = players.update(req.player.id, (d) => { d.academyPlus = req.body.enabled; });
    seam('academyplus.after_row');
    if (stored.academyPlus && !stored.badges.includes('Fresh Start')) players.addItem(req.player.id, 'badges', 'Fresh Start');
    if (!stored.academyPlus && stored.badges.includes('Fresh Start')) players.setItems(req.player.id, 'badges', stored.badges.filter((b) => b !== 'Fresh Start'));
    stored = players.byId(req.player.id);
    broadcast('players', { playerId: req.player.id });
  });
  res.json({ academyPlus: stored.academyPlus, badges: stored.badges });
});

playerRouter.post('/badges', (req, res) => {
  const { badges } = req.body || {};
  if (!Array.isArray(badges)) return res.status(400).json({ error: 'BADGES_MUST_BE_ARRAY' });
  const stored = players.setItems(req.player.id, 'badges', badges.slice(0, 6).map(String)); // the whole list rewritten as rows, duplicates kept as given
  broadcast('players', { playerId: req.player.id });
  res.json({ badges: stored });
});

// Media upload. `dataUrl` carries the actual video (~12MB cap; the storage
// adapter writes it to disk, object storage slots in behind the same endpoint).
playerRouter.post('/media', (req, res) => {
  const { title, kind = 'video', dataUrl, attendanceId } = req.body || {};
  if (!reqText(title, 160)) return res.status(400).json({ error: 'TITLE_REQUIRED' }); // an object title would crash every screen showing it
  if (!optText(kind, 20)) return badField(res, 'kind');
  if (!moderateOrRefuse(res, title, { kind: 'media_title', playerId: req.player.id })) return;
  const item = { id: nextId('media'), title, kind, uploadedAt: new Date().toISOString(), url: null, views: 0, tags: {}, verifiedClip: null };
  if (dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'BAD_DATA_URL' });
    }
    if (dataUrl.length > 16_000_000) {
      return res.status(413).json({ error: 'FILE_TOO_LARGE', message: 'Uploads are capped at ~12MB in this prototype.' });
    }
    if (!storage.saveDataUrl(item.id, dataUrl)) return res.status(400).json({ error: 'BAD_DATA_URL' });
    item.url = `/media/${item.id}`;
  }
  // The Verified Clip seal: footage linked to a GPS+device-confirmed fixture.
  if (attendanceId) {
    const att = req.player.attendance.find((a) => a.id === attendanceId);
    if (!att) return res.status(400).json({ error: 'ATTENDANCE_NOT_FOUND', message: 'A verified clip must link one of YOUR verified attendances.' });
    if (!item.url) return res.status(400).json({ error: 'FILE_REQUIRED_FOR_VERIFIED_CLIP', message: 'Attach the actual footage to claim the Verified Clip seal.' });
    item.verifiedClip = att.id;
  }
  // ONE unit of work: the clip row and the activity it records (the log
  // entry, any badge, its notification) commit together before the 201.
  try {
    unit(() => {
      players.addItem(req.player.id, 'media', item);
      seam('media.after_row');
      recordActivity(req.player);
      broadcast('players', { playerId: req.player.id });
    });
  } catch (e) {
    if (e?.code === 'PLAYER_RECORD_INVALID' || e?.code === 'PLAYER_SUBRECORD_INVALID') return res.status(400).json({ error: 'PLAYER_INVALID', message: String(e.message) });
    throw e;
  }
  res.status(201).json({ media: item, trustScore: computeTrustScore(players.byId(req.player.id)) });
});

// Medical data is player-controlled per data-protection law.
// For a minor, that control sits with the guardian.
playerRouter.post('/medical/share', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  if (switchRefused(res, req.body?.shared, 'shared')) return;
  const stored = players.update(req.player.id, (d) => { d.medical.shared = req.body.shared; });
  broadcast('players', { playerId: req.player.id });
  res.json({ shared: stored.medical.shared });
});

playerRouter.post('/medical/records', (req, res) => {
  const { type, title, date, layoffWeeks, cleared, conditionStatus } = req.body || {};
  if (date && !dateOnlyOrRefuse(res, date, 'date')) return; // a medical record is dated on a day that exists
  // Each field has its type; nothing else is stored.
  for (const [f, v, max] of [['type', type, 40], ['title', title, 160], ['conditionStatus', conditionStatus, 40]]) if (!optText(v, max)) return badField(res, f);
  if (layoffWeeks != null && !(typeof layoffWeeks === 'number' && Number.isFinite(layoffWeeks) && layoffWeeks >= 0 && layoffWeeks <= 520)) return badField(res, 'layoffWeeks');
  if (cleared != null && typeof cleared !== 'boolean') return badField(res, 'cleared');
  // ONE unit of work: the condition column and the record
  // (a facet of the same player) commit together before the response, so a
  // crash after the answer can never leave the column without its record.
  try {
    unit(() => {
      if (conditionStatus) players.update(req.player.id, (d) => { d.medical.conditionStatus = conditionStatus; });
      seam('medical.records.after_row');
      if (title) {
        players.addItem(req.player.id, 'medical.records', { id: nextId('md'), type: type || 'note', title, date: date || new Date().toISOString().slice(0, 10), layoffWeeks: layoffWeeks ?? null, cleared: cleared ?? null });
      }
      broadcast('players', { playerId: req.player.id });
    });
  } catch (e) {
    if (e?.code === 'PLAYER_RECORD_INVALID' || e?.code === 'PLAYER_SUBRECORD_INVALID') return res.status(400).json({ error: 'PLAYER_INVALID', message: String(e.message) });
    throw e;
  }
  res.status(201).json(players.byId(req.player.id).medical);
});

// Location powers the Grassroots 50km radius. Coordinates never appear in
// any org view — only the computed distance does.
playerRouter.post('/location', (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'BAD_COORDINATES' });
  }
  players.update(req.player.id, (d) => { d.location = { lat, lng }; });
  broadcast('players', { playerId: req.player.id });
  res.json({ ok: true });
});

// The player's self-service declaration. `under_contract` is CANONICAL
// contract truth and is written by exactly one thing — the completed-signing
// writer (m29Ctx) — so it cannot be self-declared here, and
// while a canonical live contract stands no self-declared word replaces it.
// The other five words remain the player's own to declare (their intent and
// their reading of a contract ScoutBox did not write); availability is always
// theirs.
const SELF_DECLARABLE_CONTRACT_STATUSES = ['expiring_summer', 'scholarship_ending', 'release_approaching', 'free_agent', 'unknown'];
playerRouter.post('/availability', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  const { availability, contractStatus } = req.body || {};
  const AV = ['available_now', 'end_of_season', 'loan_open', 'overseas_open', 'not_seeking'];
  const CS = ['under_contract', ...SELF_DECLARABLE_CONTRACT_STATUSES];
  if (availability && !AV.includes(availability)) return res.status(400).json({ error: 'BAD_AVAILABILITY', allowed: AV });
  if (contractStatus && !CS.includes(contractStatus)) return res.status(400).json({ error: 'BAD_CONTRACT_STATUS', allowed: CS });
  if (contractStatus === 'under_contract') {
    return res.status(403).json({ error: 'CONTRACT_STATUS_NOT_SELF_DECLARABLE', message: 'Under contract is recorded when a signing completes in ScoutBox; it cannot be declared here.', allowed: SELF_DECLARABLE_CONTRACT_STATUSES });
  }
  if (contractStatus) {
    const canonical = canonicalContractFor(req.player.id);
    if (canonical) {
      return res.status(409).json({ error: 'CONTRACT_STATUS_CANONICAL', message: 'Your contract status is set by a signing completed in ScoutBox and cannot be changed here while that contract stands.', contractStatus: req.player.contractStatus, endDate: canonical.endDate ?? null });
    }
  }
  const stored = availability || contractStatus
    ? players.update(req.player.id, (d) => { if (availability) d.availability = availability; if (contractStatus) d.contractStatus = contractStatus; })
    : req.player;
  broadcast('players', { playerId: req.player.id });
  res.json({ availability: stored.availability, contractStatus: stored.contractStatus });
});

// Verified Match Attendance: fixture + venue + date + GPS + device required.
// (Prototype verification; production = geofence + device attestation.)
playerRouter.post('/attendance', (req, res) => {
  const { fixture, venue, date, gps, deviceId } = req.body || {};
  const missing = ['fixture', 'venue', 'date'].filter((f) => !req.body?.[f]);
  if (!gps || typeof gps.lat !== 'number' || typeof gps.lng !== 'number') missing.push('gps{lat,lng}');
  if (!deviceId) missing.push('deviceId');
  if (missing.length) {
    return res.status(400).json({ error: 'ATTENDANCE_UNVERIFIABLE', message: 'Verified attendance needs fixture, venue, date, GPS and device data.', missing });
  }
  if (!dateOnlyOrRefuse(res, date, 'date')) return; // verified attendance on a day that exists
  // The attendance row stores gps as two columns: a gps carrying anything else is refused, not silently trimmed.
  if (Object.keys(gps).some((k) => k !== 'lat' && k !== 'lng')) return res.status(400).json({ error: 'GPS_INVALID', message: 'gps is { lat, lng } and nothing else.' });
  const item = { id: nextId('att'), fixture, venue, date, gps: { lat: gps.lat, lng: gps.lng }, deviceConfirmed: true, verified: true };
  // ONE unit of work: the attendance row, the activity it records and the
  // ledger row commit together before the 201. A fixture or venue the table
  // cannot hold (not text) is refused by the repository and answered 400.
  try {
    unit(() => {
      players.addItem(req.player.id, 'attendance', item);
      seam('attendance.after_row');
      recordActivity(req.player);
      ledgerAppend({ type: 'attendance_verified', playerId: req.player.id, orgId: null, orgName: 'ScoutBox', userId: null, scoutName: 'system' });
      broadcast('players', { playerId: req.player.id });
    });
  } catch (e) {
    if (e?.code === 'PLAYER_RECORD_INVALID' || e?.code === 'PLAYER_SUBRECORD_INVALID') return res.status(400).json({ error: 'PLAYER_INVALID', message: String(e.message) });
    throw e;
  }
  res.status(201).json({ attendance: item, trustScore: computeTrustScore(players.byId(req.player.id)) });
});

playerRouter.post('/timeline', (req, res) => {
  const { year, event } = req.body || {};
  if (!year || !event) return res.status(400).json({ error: 'YEAR_AND_EVENT_REQUIRED' });
  if (!moderateOrRefuse(res, event, { kind: 'timeline_event', playerId: req.player.id })) return;
  players.addItem(req.player.id, 'timeline', { year: String(year), event: String(event) }); // one row, committed before the response
  broadcast('players', { playerId: req.player.id });
  res.status(201).json({ timeline: players.byId(req.player.id).timeline });
});

// Children keep their football life: stats edits and drills stay open.
// Passing `season` (e.g. "2024/25") files the numbers into season history
// instead of the current season.
playerRouter.post('/stats', (req, res) => {
  const FIELDS = ['appearances', 'goals', 'assists', 'paceKmh', 'passCompletionPct', 'duelSuccessPct', 'cleanSheets'];
  const updates = {};
  for (const f of FIELDS) {
    if (req.body?.[f] !== undefined) {
      // A number, never text turned into one; the counts whole, the percentages at most 100.
      const v = req.body[f];
      const count = ['appearances', 'goals', 'assists', 'cleanSheets'].includes(f);
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (count && !Number.isSafeInteger(v)) || (f.endsWith('Pct') && v > 100)) return res.status(400).json({ error: 'BAD_STAT', field: f });
      updates[f] = v;
    }
  }
  const season = typeof req.body?.season === 'string' && req.body.season.trim() ? req.body.season.trim() : null;
  // ONE unit of work: the stat columns (or the season facet) and the activity
  // bookkeeping — the activity log, any badge it earns and its notification —
  // commit together.
  unit(() => {
    if (season) {
      // The season history is rows of player_season_history; the whole
      // (sorted) list is rewritten.
      const history = (req.player.seasonHistory ?? []).map((s) => ({ ...s }));
      const existing = history.find((s) => s.season === season);
      if (existing) Object.assign(existing, updates);
      else history.push({ season, appearances: 0, goals: 0, assists: 0, ...updates });
      history.sort((a, b) => (a.season < b.season ? 1 : -1));
      players.setItems(req.player.id, 'seasonHistory', history);
    } else {
      players.update(req.player.id, (d) => { d.stats = { ...(d.stats ?? {}), appearances: d.stats?.appearances ?? 0, goals: d.stats?.goals ?? 0, assists: d.stats?.assists ?? 0, ...updates }; });
    }
    seam('stats.after_row');
    recordActivity(req.player);
    broadcast('players', { playerId: req.player.id });
  });
  const stored = players.byId(req.player.id);
  res.json({ stats: stored.stats, seasonHistory: stored.seasonHistory });
});

// The at-home verified combine: standardised drills with a measurable metric.
// Recording the drill on video marks the result VERIFIED (prototype: video
// presence; production runs computer-vision analysis behind the same call).
export const DRILLS = [
  { id: 'drill-sprint-ladder', name: 'Sprint ladder — 6×30m', metric: 'best 30m time', unit: 's', benchmark: 4.2, lowerIsBetter: true },
  { id: 'drill-passing-gates', name: 'Passing gates — both feet', metric: 'gates hit of 20', unit: '/20', benchmark: 14, lowerIsBetter: false },
  { id: 'drill-shooting-arc', name: 'Shooting arc — 20 finishes', metric: 'on-target finishes', unit: '/20', benchmark: 12, lowerIsBetter: false },
  { id: 'drill-first-touch', name: 'First touch — wall rebounds', metric: 'touches in 60s', unit: '', benchmark: 45, lowerIsBetter: false },
];

playerRouter.get('/drills', (req, res) => {
  res.json(
    DRILLS.map((d) => ({
      ...d,
      completed: (req.player.drills ?? []).includes(d.id),
      // A player who has never completed a drill has no `drillResults` yet (a
      // sign-up creates none; the first completion appends the array). Read as
      // empty.
      best: (req.player.drillResults ?? [])
        .filter((r) => r.drillId === d.id)
        .sort((a, b) => (d.lowerIsBetter ? a.value - b.value : b.value - a.value))[0] ?? null,
    }))
  );
});

playerRouter.post('/drills/:id/complete', (req, res) => {
  const drill = DRILLS.find((d) => d.id === req.params.id);
  if (!drill) return res.status(404).json({ error: 'DRILL_NOT_FOUND' });
  const { value, videoDataUrl } = req.body || {};
  const numeric = value !== undefined && value !== null && value !== '' ? Number(value) : null;
  if (numeric !== null && (Number.isNaN(numeric) || numeric < 0)) return res.status(400).json({ error: 'BAD_VALUE' });
  // ONE unit of work: the drill row, the result row and the activity commit together.
  unit(() => {
    if (!(req.player.drills ?? []).includes(drill.id)) players.addItem(req.player.id, 'drills', drill.id);
    if (numeric !== null) {
      players.addItem(req.player.id, 'drillResults', {
        id: nextId('combine'),
        drillId: drill.id,
        drillName: drill.name,
        metric: drill.metric,
        unit: drill.unit,
        value: numeric,
        verified: !!videoDataUrl, // video-backed = combine-verified
        ts: Date.now(),
      });
    }
    seam('drills.complete.after_row');
    recordActivity(req.player);
    broadcast('players', { playerId: req.player.id });
  });
  const stored = players.byId(req.player.id);
  res.json({ drills: stored.drills, drillResults: stored.drillResults });
});

// ---------------------------------------------- the Grassroots journey
// Everything in this block is exclusive to amateur/semi-pro players.
function grassrootsOnly(req, res) {
  if (req.player.level === 'pro') {
    res.status(403).json({ error: 'GRASSROOTS_ONLY', message: 'This is part of the Grassroots journey — pro-level players have moved past it.' });
    return true;
  }
  return false;
}

// Free structured training programmes, built from the verified combine.
playerRouter.get('/programme', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  res.json({
    current: programmeProgress(req.player),
    tracks: Object.values(PROGRAMME_TRACKS).map(({ key, label, positions, sessions }) => ({ key, label, positions, sessionsPerWeek: sessions.length })),
    suggested: trackForPosition(req.player.position),
  });
});

playerRouter.post('/programme', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  const track = PROGRAMME_TRACKS[req.body?.track];
  if (!track) return res.status(400).json({ error: 'TRACK_NOT_FOUND' });
  // track and startedAt are columns; `completed` is rows of
  // player_programme_completions. ONE unit of work: the new track and the
  // reset of the completed sessions commit together.
  unit(() => {
    players.update(req.player.id, (d) => { d.programme = { track: track.key, startedAt: Date.now(), completed: d.programme?.completed ?? [] }; });
    seam('programme.select.after_row');
    players.setItems(req.player.id, 'programme.completed', []);
    broadcast('players', { playerId: req.player.id });
  });
  res.status(201).json({ current: programmeProgress(players.byId(req.player.id)) });
});

playerRouter.post('/programme/sessions/:id/complete', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  if (!req.player.programme) return res.status(409).json({ error: 'NO_PROGRAMME', message: 'Pick a training track first.' });
  const track = PROGRAMME_TRACKS[req.player.programme.track];
  const session = track?.sessions.find((x) => x.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
  // ONE unit of work: the completion row and the activity commit together.
  unit(() => {
    players.addItem(req.player.id, 'programme.completed', { sessionId: session.id, ts: Date.now() });
    recordActivity(req.player); // programme work feeds streaks + the weekly goal
    broadcast('players', { playerId: req.player.id });
  });
  res.json({ current: programmeProgress(players.byId(req.player.id)) });
});

// Honest context, never a leaderboard: percentiles vs the amateur/semi-pro
// cohort in the same position group. Small cohorts return null.
playerRouter.get('/benchmarks', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  // The cohort (grassrootsJourney.mjs inCohort: not pro, the same position track) is a SQL filter, read as light
  // rows for the statistics and as one GROUP BY for the drill bests; nobody is decoded.
  const track = trackForPosition(req.player.position);
  const cohortFilter = { notLevel: 'pro', exceptId: req.player.id, positions: PLAYER_POSITIONS.filter((pos) => trackForPosition(pos) === track), orNoPosition: trackForPosition(null) === track };
  const cohort = [];
  players.scanLight(cohortFilter, (c) => { if (inCohort(req.player, c)) cohort.push(c); });
  const bests = players.drillBests(cohortFilter);
  const drillBests = (playerX, drillId, lowerIsBetter) => {
    const results = (playerX.drillResults ?? []).filter((r) => r.drillId === drillId);
    if (!results.length) return null;
    const values = results.map((r) => r.value);
    return lowerIsBetter ? Math.min(...values) : Math.max(...values);
  };
  const drills = DRILLS.map((d) => {
    const mine = drillBests(req.player, d.id, d.lowerIsBetter);
    if (mine === null) return null;
    const cohortValues = (bests.get(d.id) ?? []).map((b) => (d.lowerIsBetter ? b.min : b.max));
    const percentile = percentileAmong(mine, cohortValues, d.lowerIsBetter);
    // Sample size and method travel with every comparison; a
    // too-small cohort says "not enough evidence" instead of a number.
    return { drillId: d.id, name: d.name, metric: d.metric, unit: d.unit, value: mine, percentile, sampleSize: cohortValues.length, insufficient: percentile === null };
  }).filter(Boolean);
  const statKeys = ['goals', 'assists', 'appearances', 'passCompletionPct', 'duelSuccessPct'];
  const stats = statKeys.map((k) => {
    const mine = req.player.stats?.[k];
    if (typeof mine !== 'number') return null;
    const cohortValues = cohort.map((c) => c.stats?.[k]).filter((v) => typeof v === 'number');
    const percentile = percentileAmong(mine, cohortValues, false);
    return { stat: k, value: mine, percentile, sampleSize: cohortValues.length, insufficient: percentile === null };
  }).filter(Boolean);
  res.json({
    cohortSize: cohort.length,
    method: 'Percentile of your best result among amateur & semi-pro players in your position group with the same measurement recorded. Cohorts under 3 comparable records show "not enough evidence" instead of a percentile. Incompatible records (other positions, pro level, missing values) are excluded.',
    note: 'Percentiles vs amateur & semi-pro players in your position group — context, not competition.',
    drills, stats,
  });
});

// The opportunity radar: the 50km rule, pointed the player's way.
playerRouter.get('/opportunities', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  if (!req.player.location) return res.json({ clubs: [], note: 'Set your location to see clubs within reach.' });
  const near = orgs.locatedInBox(boxAround(req.player.location, GRASSROOTS_RADIUS_KM), { level: 'grassroots' })
    .map((o) => ({ org: o, distanceKm: Math.round(haversineKm(o.location, req.player.location) * 10) / 10 }))
    .filter((x) => x.distanceKm <= GRASSROOTS_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  // The clubs' upcoming open days in one query.
  const upcoming = Map.groupBy(grassroots.openTrials.upcomingForOrgs(near.map((x) => x.org.id), new Date().toISOString().slice(0, 10)), (t) => t.orgId);
  const clubs = near
    .map(({ org, distanceKm }) => ({
      id: org.id, name: org.name, city: org.location.city ?? '', distanceKm,
      verified: org.verified, safeguardingCertified: safeguardingCertified(org),
      ...pathwayRecord(org),
      lookingFor: [...clubSetup.lookingFor.forOrg(org.id)],
      openTrials: (upcoming.get(org.id) ?? []).map((t) => ({ ...openTrialView(t), registered: t.registrations.some((r) => r.playerId === req.player.id) })),
    }));
  res.json({ radiusKm: GRASSROOTS_RADIUS_KM, clubs, lookingForYou: clubs.filter((c) => c.lookingFor.includes(req.player.position)).length });
});

// Open trial days near the player. Adults register directly; minors see them
// but registration belongs to the guardian — Scout → Parent, always.
playerRouter.post('/open-trials/:id/register', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  if (guardianManagedOnly(req, res)) return;
  const trial = grassroots.openTrials.byId(req.params.id);
  if (!trial) return res.status(404).json({ error: 'OPEN_TRIAL_NOT_FOUND' });
  const org = byId.org(trial.orgId);
  if (!org || !req.player.location || !org.location || haversineKm(org.location, req.player.location) > GRASSROOTS_RADIUS_KM) {
    return res.status(403).json({ error: 'OUT_OF_RADIUS', message: 'Open days are local — this one is beyond 50km of you.' });
  }
  if (trial.registrations.some((r) => r.playerId === req.player.id)) return res.status(409).json({ error: 'ALREADY_REGISTERED' });
  // ONE unit of work: the registration, the ledger row and the notification commit together.
  unit(() => {
    grassroots.openTrials.register(trial.id, { id: nextId('otr'), playerId: req.player.id, playerName: req.player.name?.slice(0, GL.playerName) ?? null, byGuardian: false, guardianId: null, ts: Date.now() });
    ledgerAppend({ type: 'open_trial_registration', playerId: req.player.id, orgId: org.id, orgName: org.name, userId: trial.createdByUserId, scoutName: 'open day' });
    notify({ kind: 'org_user', id: trial.createdByUserId }, 'open_trial', `${req.player.name} registered for "${trial.title}".`, trial.id);
  });
  res.status(201).json({ registered: true });
});

// First Team Seekers: Grassroots' own cohort — need-based, free, never
// purchasable. Adults set it themselves; guardians set it for children.
playerRouter.post('/first-team-seeker', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  if (guardianManagedOnly(req, res)) return;
  if (switchRefused(res, req.body?.enabled, 'enabled')) return;
  const stored = players.update(req.player.id, (d) => { d.firstTeamSeeker = req.body.enabled; });
  broadcast('players', { playerId: req.player.id });
  res.json({ firstTeamSeeker: stored.firstTeamSeeker });
});

// Coach vouches: a named, verified local coach is the most valuable
// credential an amateur can hold. The coach proves mailbox control with a
// one-time code; the text is moderated like every other message.
// The code is stored only as its SHA-256 hash (the coach's email carries it); junk is refused, not coerced.
function createVouchRequest(player, { coachName, coachEmail, role }, res) {
  const VL = TRANSITION_LIMITS;
  for (const [field, v] of [['coachName', coachName], ['coachEmail', coachEmail], ['role', role]]) {
    if (v !== undefined && v !== null && typeof v !== 'string') return res.status(400).json({ error: 'FIELD_INVALID', field, message: `${field} is text.` });
  }
  const name = (coachName ?? '').trim();
  const email = (coachEmail ?? '').trim();
  if (!name || !email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'COACH_DETAILS_REQUIRED', message: 'Name the coach and their email address.' });
  }
  if (name.length > VL.coachName) return res.status(400).json({ error: 'FIELD_INVALID', field: 'coachName', message: `At most ${VL.coachName} characters.` });
  if (email.length > VL.coachEmail) return res.status(400).json({ error: 'FIELD_INVALID', field: 'coachEmail', message: `At most ${VL.coachEmail} characters.` });
  const code = randomCode(8);
  const vouch = unit(() => transitionsVouches.vouches.create({ // in a unit, so the id counter commits with the row
    id: nextId('vch'), playerId: player.id, playerName: player.name?.slice(0, VL.name) ?? null, // names have no limit at signup: shortened, never refused
    coachName: name, coachEmail: email, role: (role ?? '').trim().slice(0, VL.role) || 'Coach',
    status: 'pending', codeHash: vouchCodeHash(code), text: null, seasons: null, ts: Date.now(), publishedAt: null,
    conflictOfInterest: null, withdrawn: null,
  }));
  mailer.send({
    to: vouch.coachEmail,
    subject: `Reference request for ${player.name} on ScoutBox`,
    text: `Hi ${vouch.coachName},

${player.name} has asked you for a coach reference on ScoutBox Grassroots.

Your one-time reference code is ${code}. Submitting with it confirms this mailbox is yours; your name and role will appear with the reference on ${player.name}'s profile.

References are screened by moderation and reviewed by Trust & Safety.`,
  }).catch((err) => console.error(`reference request ${vouch.id}: the mail was not recorded or sent (${err?.code ?? err?.message ?? err})`)); // observed, never an unhandled rejection
  res.status(201).json({ requested: true, vouchId: vouch.id });
}

// The season wrap: everything the year added up to, in one card.
playerRouter.get('/season-wrap', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  const p = req.player;
  // Longest streak ever, from the activity log.
  const DAY_MS = 24 * 3600 * 1000;
  const days = [...new Set((p.activityLog ?? []).map((ts) => Math.floor(ts / DAY_MS)))].sort((a, b) => a - b);
  let bestStreak = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
  }
  const verifiedBests = (p.drillResults ?? []).filter((r) => r.verified);
  res.json({
    generatedAt: new Date().toISOString(),
    player: { name: p.name, position: p.position, level: p.level ?? 'amateur' },
    season: p.stats ?? null,
    verifiedAttendances: (p.attendance ?? []).length,
    verifiedClips: (p.media ?? []).filter((m) => m.verifiedClip).length,
    bestStreak,
    combineBests: verifiedBests.slice(-4).map((r) => ({ drillName: r.drillName, metric: r.metric, value: r.value, unit: r.unit })),
    badges: p.badges,
    coachVouches: publishedVouchesFor(p.id).length,
    scoutViews: safetyAudit.ledger.countForPlayer(p.id, 'view'),
    note: 'Your season, verified. Every number above is backed by the ledger — no vanity metrics.',
  });
});

playerRouter.post('/vouches/request', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  if (guardianManagedOnly(req, res)) return;
  createVouchRequest(req.player, req.body ?? {}, res);
});

// One-click reporting + blocking, available to every player.
playerRouter.post('/report', (req, res) => handleReport(req, res, { by: 'player', byId: req.player.id }));

playerRouter.post('/block', (req, res) => {
  const { orgId, reason } = req.body || {};
  if (!orgId) return res.status(400).json({ error: 'ORG_REQUIRED' });
  if (!reqText(orgId, 200)) return badField(res, 'orgId');
  if (!optText(reason)) return badField(res, 'reason');
  if (!byId.org(orgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
  unit(() => {
    safetyAudit.blocks.add({ id: nextId('blk'), playerId: req.player.id, orgId, by: 'player', reason: reason || '', ts: Date.now() });
    ledgerAppend({ type: 'org_blocked_by_player', playerId: req.player.id, orgId, orgName: byId.org(orgId).name, userId: null, scoutName: 'player' });
  });
  broadcast('players');
  res.status(201).json({ blocked: true });
});

// ------------------------------------------------- pairing, prefs, export
// Child device pairing: the guardian mints a short-lived code; the child's
// device exchanges it for their limited login.
guardianRouter.post('/children/:id/pairing-code', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  if (rateLimit.limited('pairing_code_mint', req.guardian.id)) return res.status(429).json(rateLimitedBody('pairing_code_mint'));
  // A row of pairing_codes — random (CSPRNG, never id-derived), stored as a
  // hash, 15-minute lifetime, one live code per child (the previous one
  // replaced) — durable BEFORE the response is sent. The plain code exists in
  // this response only.
  const { code, expiresAt } = codes.issuePairingCode(child.id);
  res.status(201).json({ code, expiresAt });
});

app.post('/auth/player/pair', (req, res) => {
  const { code } = req.body || {};
  // A wrong code is charged per client address (a correct one costs
  // nothing), on top of the per-IP /auth limiter; the budget is tested first.
  const source = req.ip ?? req.socket?.remoteAddress ?? '?';
  if (rateLimit.peek('pairing_attempt', source).remaining === 0) return res.status(429).json(rateLimitedBody('pairing_attempt')); // exactly `max` wrong codes are judged; the next attempt is refused
  const live = codes.peekPairingCode(code);
  const p = live ? findPlayer(live.playerId) : null;
  if (!live || !p) {
    if (live && !p) codes.revokePairingCodesFor(live.playerId); // a code whose player is gone (never written by this server) is dead
    rateLimit.limited('pairing_attempt', source);
    return res.status(404).json({ error: 'CODE_INVALID', message: 'That pairing code is wrong or expired — ask your parent/guardian for a fresh one.' });
  }
  // ONE unit of work: the code is consumed (its row deleted) and the child's
  // session created together — a failure anywhere, the real COMMIT included,
  // keeps the code live and creates no session; a crash between the two
  // cannot leave a committed session beside a still-live code.
  let token = null;
  unit(() => {
    const consumed = codes.consumePairingCode(code);
    if (!consumed || consumed.playerId !== p.id) throw new Error('pairing: the code changed between the check and the exchange');
    seam('pairing.after_consume');
    token = createSession('player', p.id);
  });
  res.json({ playerId: p.id, name: p.name, token });
});

// Device push-token registration (used when EXPO_ACCESS_TOKEN switches the push adapter live; stored in dev too).
// Players and guardians only (the Player app's accounts; staff are notified in their portal and by e-mail).
// One row per device token: a token another account registered moves to this one, so a shared phone receives only
// the notices of the account that last signed in on it.
app.post('/push/register', (req, res) => {
  const session = sessionFor(req);
  if (!session) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'TOKEN_REQUIRED' });
  // A device token is a string (Expo's ExponentPushToken[…]) of at most 200 characters; anything else is refused.
  if (typeof token !== 'string' || token.length > 200) return res.status(400).json({ error: 'TOKEN_INVALID', message: 'A device token is text of at most 200 characters.' });
  if (session.kind !== 'player' && session.kind !== 'guardian') return res.status(403).json({ error: 'PUSH_NOT_AVAILABLE', message: 'Push notifications go to the Player app\'s players and guardians.' });
  const { moved } = pushTokens.register({ kind: session.kind, refId: session.refId, token, ts: Date.now() });
  res.status(201).json({ registered: true, moved });
});

// Guardian view of open trial days near a child, and registration — the
// guardian decides, the child never talks to anyone. Minor registrations
// only reach clubs allowed to see the child (verified + local).
guardianRouter.get('/children/:id/open-trials', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  if (!child.location) return res.json({ openTrials: [], note: 'Set a location on the profile to see local open days.' });
  // The open days hosted inside the radius's box (one query; past ones too, so a parent still sees the day their
  // child registered for); the exact distance and visibility here.
  const list = grassroots.openTrials.inBox(boxAround(child.location, GRASSROOTS_RADIUS_KM))
    .map((t) => ({ t, org: byId.org(t.orgId) }))
    .filter(({ org }) => org?.level === 'grassroots' && org.location && haversineKm(org.location, child.location) <= GRASSROOTS_RADIUS_KM)
    .filter(({ org }) => visibleToOrg(child, org)) // only clubs that may see the child at all
    .map(({ t, org }) => ({
      id: t.id, title: t.title, date: t.date, venue: t.venue, ageGroup: t.ageGroup, positions: [...t.positions],
      orgName: org.name, verified: org.verified, safeguardingCertified: safeguardingCertified(org),
      distanceKm: Math.round(haversineKm(org.location, child.location) * 10) / 10,
      registered: t.registrations.some((r) => r.playerId === child.id),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  res.json({ openTrials: list });
});

guardianRouter.post('/open-trials/:id/register', (req, res) => {
  const child = findPlayer(req.body?.childId);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  const trial = grassroots.openTrials.byId(req.params.id);
  if (!trial) return res.status(404).json({ error: 'OPEN_TRIAL_NOT_FOUND' });
  const org = byId.org(trial.orgId);
  if (!org || !visibleToOrg(child, org)) {
    return res.status(403).json({ error: 'VERIFIED_CLUBS_ONLY', message: 'Only verified, local clubs can receive an under-18 registration.' });
  }
  if (trial.registrations.some((r) => r.playerId === child.id)) return res.status(409).json({ error: 'ALREADY_REGISTERED' });
  // ONE unit of work: the registration, the ledger row and the notifications commit together.
  unit(() => {
    grassroots.openTrials.register(trial.id, { id: nextId('otr'), playerId: child.id, playerName: child.name?.slice(0, GL.playerName) ?? null, byGuardian: true, guardianId: req.guardian.id, ts: Date.now() });
    ledgerAppend({ type: 'open_trial_registration_by_guardian', playerId: child.id, orgId: org.id, orgName: org.name, userId: trial.createdByUserId, scoutName: 'open day' });
    notify({ kind: 'org_user', id: trial.createdByUserId }, 'open_trial', `${child.name} (via guardian) registered for "${trial.title}".`, trial.id);
    notify({ kind: 'player', id: child.id }, 'open_trial', `Your parent/guardian registered you for ${org.name}'s open day "${trial.title}" — good luck!`, trial.id);
  });
  res.status(201).json({ registered: true });
});

guardianRouter.post('/children/:id/first-team-seeker', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  if (child.level === 'pro') return res.status(403).json({ error: 'GRASSROOTS_ONLY' });
  if (switchRefused(res, req.body?.enabled, 'enabled')) return;
  const stored = players.update(child.id, (d) => { d.firstTeamSeeker = req.body.enabled; });
  broadcast('players', { playerId: child.id });
  res.json({ firstTeamSeeker: stored.firstTeamSeeker });
});

guardianRouter.post('/children/:id/vouches/request', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  if (child.level === 'pro') return res.status(403).json({ error: 'GRASSROOTS_ONLY' });
  createVouchRequest(child, req.body ?? {}, res);
});

// Notification preferences — quiet hours + the minors' school-hours mute.
function prefsHandler(getTarget) {
  return (req, res) => {
    let target = getTarget(req);
    if (req.method === 'POST') {
      const { quietStart, quietEnd, schoolHoursMute, timezone } = req.body || {};
      // Quiet hours are HH:MM wall-clock values in a named zone.
      const hhmm = (v) => v == null || v === '' ? null : (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined);
      const qs = hhmm(quietStart); const qe = hhmm(quietEnd);
      if (qs === undefined || qe === undefined) return res.status(400).json({ error: 'TIME_INVALID', message: 'Quiet hours are written HH:MM (24-hour).', expected: 'HH:MM' });
      if (timezone != null && timezone !== '' && !validateIanaZone(timezone).ok) return res.status(400).json({ error: 'TIMEZONE_INVALID', message: 'timezone must be an IANA time zone name, for example Europe/London.' });
      const notificationPrefs = {
        quietStart: quietStart === undefined ? target.notificationPrefs?.quietStart ?? null : qs,
        quietEnd: quietEnd === undefined ? target.notificationPrefs?.quietEnd ?? null : qe,
        schoolHoursMute: schoolHoursMute ?? target.notificationPrefs?.schoolHoursMute ?? null,
        timezone: timezone === undefined ? target.notificationPrefs?.timezone ?? null : (timezone || null),
      };
      // A column-backed composite on both records: through the owning repository.
      if (schoolHoursMute != null && typeof schoolHoursMute !== 'boolean') return res.status(400).json({ error: 'FIELD_INVALID', field: 'schoolHoursMute', message: 'schoolHoursMute must be true or false.' });
      const empty = Object.values(notificationPrefs).every((v) => v === null);
      target = players.byId(target.id)
        ? players.update(target.id, (d) => { d.notificationPrefs = empty ? null : notificationPrefs; })
        : guardians.setNotificationPrefs(target.id, empty ? null : notificationPrefs);
    }
    res.json({ prefs: target.notificationPrefs ?? null, note: 'Quiet hours and the school-hours mute apply to push delivery; the in-app feed always keeps the record.' });
  };
}
playerRouter.get('/prefs', prefsHandler((req) => req.player));
playerRouter.post('/prefs', prefsHandler((req) => req.player));
guardianRouter.get('/prefs', prefsHandler((req) => req.guardian));
guardianRouter.post('/prefs', prefsHandler((req) => req.guardian));

// Data rights: full export, and deletion that keeps the append-only ledger
// (audit/attribution basis) but removes the person's content.
function exportPlayer(p) {
  const { password, ...profile } = p;
  return {
    exportedAt: new Date().toISOString(),
    profile,
    requests: recruitment.requests.forPlayer(p.id).map(requestForRecipient),
    threads: channels.forPlayer(p.id).map((c) => channelViewFor(c, 'player')),
    notifications: notificationsFor('player', p.id),
    insights: insightsFor(p.id),
    ledgerEvents: safetyAudit.ledger.forPlayer(p.id).map(ledgerView),
  };
}

function deletePlayerData(playerId) {
  const p = findPlayer(playerId);
  if (!p) return false;
  const at = Date.now();
  const mediaIds = p.media.map((m) => m.id);
  let uploadIds = [];
  // ONE unit of work: the player row becomes the retained record and its
  // links go, the removal of the media FILES is queued in the same
  // transaction, every session of the person is revoked and every table that
  // names the person is tombstoned or redacted — all of it commits or none of it. The files themselves are removed only after COMMIT
  // (and again at every boot and sweep until they are gone); while an entry is
  // queued, /media/:id never serves the file.
  unit(() => {
  mediaDeletions.enqueue(mediaIds, { playerId, at });
  sessions.revokeFor('player', playerId);
  codes.revokePairingCodesFor(playerId); // before the player row
  // The row is not deleted — it is reduced to the retained record (id,
  // deleted_at, birth_date, country; placeholders and NULL elsewhere: the full
  // birth date and the country code are kept by product decision), the child
  // rows and links go, the guardians stop listing the id, and nothing serves
  // it as an account from here on.
  players.erase(playerId, { at });
  seam('player.delete.after_erase');
  // Requests and trials become id-only tombstones rather than
  // vanishing. A recruitment case that reached a trial keeps the record that
  // the trial happened (and the numbers the club itself filed); the person
  // is gone from it. The case's status is NOT touched here — deletion is not
  // a lifecycle event, and no path other than the lifecycle writer moves a
  // case. The case's copy of the name goes with the person.
  recruitment.redactPlayer(playerId, at);
  recruitmentCases.redactPlayer(playerId, at); // the case's copy of the name goes, in this unit
  scoutingAssessments.assessments.redactPlayer(playerId); // the club keeps its assessments; the player's name goes, in this unit
  recruitmentContactsOffers.contacts.redactPlayer(playerId); // the reply's words go; the contact stays
  grassroots.openTrials.redactPlayer(playerId); // the registration keeps the id; the name goes, in this unit
  uploadIds = operations.uploads.removeForPlayer(playerId); // the player's upload sessions go, in this unit (their chunk files after COMMIT)
  // Agent relationships become id-only tombstones (no name is
  // stored on them; the dispute text and any player-authored history names go).
  agentCoreDomain?.onPlayerDeleted?.(playerId, at);
  // Compliance contexts and consents keep only the id.
  complianceDomain?.onPlayerDeleted?.(playerId, at);
  // A transaction keeps its ids, roles, states and times and loses
  // the person; every representation naming the subject is withdrawn.
  transactionsDomain?.onPlayerDeleted?.(playerId, at);
  // Offers keep ids, states and times and lose the person's name and words.
  m28Ctx?.onPlayerDeleted?.(playerId, at);
  m29Ctx?.onPlayerDeleted?.(playerId, at);
  // Every thread of the player goes, guardian–club threads included, with its
  // messages, attachments and receipts, inside this unit (D-B, docs/decisions.md;
  // that settled scope, not retention).
  channels.deleteForPlayer(playerId);
  notifications.deleteForAudience('player', playerId); // the person's rows go in this unit; their preferences are retained (no cascade, by decision)
  // (Every guardian's childIds was spliced by players.erase, with the link rows.)
  // Ledger rows stay (append-only audit + attribution) but carry only ids.
  broadcast('players'); // deferred until COMMIT inside the unit
  });
  // After COMMIT: the filesystem boundary. A failure here keeps the queue entry; the next boot or sweep retries.
  mediaDeletions.process(storage);
  removeUploadChunks(DATA_DIR, uploadIds);
  return true;
}

playerRouter.get('/export', (req, res) => res.json(exportPlayer(req.player)));

playerRouter.delete('/account', (req, res) => {
  if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Ask your parent/guardian to delete this profile.' });
  deletePlayerData(req.player.id);
  res.json({ deleted: true });
});

guardianRouter.get('/export', (req, res) => {
  res.json({
    exportedAt: new Date().toISOString(),
    guardian: guardianSelfView(req.guardian),
    children: req.guardian.childIds.map((id) => findPlayer(id)).filter(Boolean).map(exportPlayer),
  });
});

guardianRouter.delete('/children/:id', (req, res) => {
  if (!req.guardian.childIds.includes(req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  deletePlayerData(req.params.id);
  res.json({ deleted: true });
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
const adminRouter = express.Router();
app.use('/admin', (req, res, next) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'ADMIN_KEY_REQUIRED' });
  // When an AUTHENTICATED reviewer session is presented beside the shared
  // key, the key-gated admin actions are attributed to that person
  // (derived from the session, never from a header). The shared key alone is
  // read-only and non-authoritative for compliance.
  const session = sessionFor(req);
  if (session?.kind === 'ts_reviewer') {
    const reviewer = compliancePolicies.reviewers.activeById(session.refId);
    if (reviewer) req.reviewer = reviewer;
  }
  next();
}, adminRouter);

// The attributed Trust & Safety lane. Every route here resolves
// a specific authenticated reviewer (never the shared key) before it runs;
// the middleware is installed by registerCompliance() below.
let complianceDomain = null;
// The Agent Transaction Workspace, declared here because the
// account-deletion sweep above runs before its registration below.
let transactionsDomain = null;
let m28Ctx = null; // assigned when the Offer module registers, below
let m29Ctx = null; // assigned when the Signing module registers, below
const tsRouter = express.Router();
app.use('/ts', (req, res, next) => (complianceDomain ? complianceDomain.reviewerAuth(req, res, next) : res.status(503).json({ error: 'REVIEWER_LANE_NOT_READY' })), tsRouter);

// The data-layer report with row-level detail: ids of rows the target schema
// refused and why, and the last projection error. Public /capabilities carries
// the counts and statuses only.
adminRouter.get('/data-layer', (_req, res) => {
  res.json(dataLayer.report({ details: true }));
});

adminRouter.get('/overview', (_req, res) => {
  res.json({
    players: players.count(),
    guardians: guardians.count(),
    orgs: orgs.count(),
    openReports: safetyAudit.reports.countOpen(),
    blocks: safetyAudit.blocks.count(),
    moderationHits: safetyAudit.moderationLog.count(),
    channels: channels.count(),
    signings: signingsFollowUps.signings.count(),
    invoices: operations.invoices.count(),
    emailsSent: outbox.count(),
    pushesSent: pushLog.count(),
    sessions: sessions.count(),
    storageEngine: store.engine,
    groomingEscalations: safetyAudit.moderationLog.count('grooming'),
    persisted: true, // every write is committed to the database before the handler answers
  });
});

// Triage order: urgent first, then oldest-pending first, then resolved (newest
// first). Paged by cursor (domains/platform/paging.mjs): { items, nextCursor }.
adminRouter.get('/reports', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number', 'number', 'number']); } catch (e) { return sendPageError(res, e); }
  const out = safetyAudit.reports.triagePage(page);
  res.json({ items: out.items.map(reportView), nextCursor: out.nextCursor });
});

// On the dev transport the outbox is the delivery, so a mail whose one-time code the persisted record withholds is shown
// with its full text while this process holds it (mailer.devDeliveredText; never saved, never backed up).
// Both lists page by cursor, newest first (the admin app reads the first page).
adminRouter.get('/outbox', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const out = outbox.page(page);
  res.json({ items: out.items.map((m) => { const full = mailer.devDeliveredText(m.id); return full ? { ...m, text: full } : m; }), nextCursor: out.nextCursor });
});
adminRouter.get('/push-log', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  res.json(pushLog.page(page));
});
// Every invoice, newest first, by cursor (`?limit=&cursor=`); the admin app reads the first page.
adminRouter.get('/invoices', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const { items, nextCursor } = operations.invoices.page(page);
  res.json({ items: items.map(invoiceView), nextCursor });
});
// Every coach reference, newest first, by cursor (`?limit=&cursor=`); the coach's email is shown to T&S, never the code.
adminRouter.get('/vouches', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const { items, nextCursor } = pageOf(transitionsVouches.vouches.page(page).rows, page.limit, (r) => r.key);
  res.json({ items: items.map(({ record: v }) => ({ ...vouchView(v), coachEmail: v.coachEmail })), nextCursor });
});
adminRouter.post('/vouches/:id/revoke', (req, res) => {
  const vouch = verificationReads.vouches.byId(req.params.id);
  if (!vouch) return res.status(404).json({ error: 'VOUCH_NOT_FOUND' });
  unit(() => transitionsVouches.vouches.revoke(vouch.id));
  broadcast('players', { playerId: vouch.playerId });
  res.json({ revoked: true });
});

adminRouter.post('/reports/:id/resolve', (req, res) => {
  const report = safetyAudit.reports.byId(req.params.id);
  if (!report) return res.status(404).json({ error: 'REPORT_NOT_FOUND' });
  if (report.status !== 'pending_review') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
  const { outcome, action } = req.body || {};
  if (!outcome || !String(outcome).trim()) return res.status(400).json({ error: 'OUTCOME_REQUIRED' });
  if (typeof outcome !== 'string' || outcome.trim().length > AUDIT_LIMITS.outcome) return badField(res, 'outcome');
  // The resolution, the organisation's suspension and the reporter's notice commit together.
  const resolved = unit(() => {
    const r = safetyAudit.reports.resolve(report.id, { outcome: outcome.trim(), at: Date.now() });
    if (action === 'suspend_org' && r.targetOrgId) orgs.update(r.targetOrgId, (d) => { d.suspended = true; });
    if (r.by !== 'system') notify({ kind: r.by, id: r.byId }, 'report_resolved', `Your report was reviewed: ${r.outcome}`, r.id); // a system escalation has no reporter to tell
    return r;
  });
  res.json(reportView(resolved));
});

// Paged by cursor, oldest first (domains/platform/paging.mjs): { items, nextCursor }.
adminRouter.get('/clubs', (req, res) => {
  let page;
  try { page = orgs.page({}, readPage(req.query, ['number'])); } catch (e) { return sendPageError(res, e); }
  res.json({ items: page.items.map((o) => ({ ...orgSafe(o), safeguardingCertified: safeguardingCertified(o) })), nextCursor: page.nextCursor });
});

// Credentialed login for organisations: Trust & Safety provisions (or
// rotates) the club password. This is how real Pro and Grassroots users sign
// in when dev shortcuts are off.
adminRouter.post('/clubs/:id/credentials', (req, res) => {
  const org = byId.org(req.params.id);
  if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
  const { password } = req.body || {};
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'PASSWORD_TOO_SHORT', message: 'Club passwords need at least 8 characters.' });
  }
  orgs.setPasswordHash(org.id, hashPassword(String(password)));
  res.json({ ok: true, note: 'Credentials provisioned — the organisation signs in with this password from now on.' });
});

adminRouter.post('/clubs/:id/verification', (req, res) => {
  const org = byId.org(req.params.id);
  if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
  const { verified, safeguardingContractSigned, verifiedDomain, suspended } = req.body || {};
  // The switches are booleans and the domain is text or null; anything else is refused, never coerced.
  for (const [f, v] of [['verified', verified], ['safeguardingContractSigned', safeguardingContractSigned], ['suspended', suspended]]) if (v !== undefined && typeof v !== 'boolean') return res.status(400).json({ error: 'FIELD_INVALID', field: f, message: `${f} must be true or false.` });
  if (verifiedDomain !== undefined && verifiedDomain !== null && !(typeof verifiedDomain === 'string' && verifiedDomain.trim().length <= ORG_LIMITS.domain)) return badField(res, 'verifiedDomain');
  // The legacy toggle's changes carry claim-level provenance so the boolean
  // and the claim engine never drift (one unit).
  const updated = unit(() => {
    orgs.update(org.id, (d) => {
      if (verified !== undefined) d.verified = verified;
      if (safeguardingContractSigned !== undefined) d.safeguardingContractSigned = safeguardingContractSigned;
      if (verifiedDomain !== undefined) d.verifiedDomain = verifiedDomain?.trim() || null;
      if (suspended !== undefined) d.suspended = suspended;
    });
    m14Ctx?.syncLegacyOrgVerification?.(org, req.body);
    return byId.org(org.id);
  });
  broadcast('players'); // visibility rules may have changed
  res.json({ ...orgSafe(updated), safeguardingCertified: safeguardingCertified(updated) });
});

registerGuardianIdReview({ adminRouter, guardians, safetyAudit, unit });

// Newest first, paged by cursor (domains/platform/paging.mjs): { items, nextCursor }.
adminRouter.get('/blocks', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const out = safetyAudit.blocks.page(page);
  res.json({ items: out.items.map(blockView), nextCursor: out.nextCursor });
});

adminRouter.post('/blocks/:id/lift', (req, res) => {
  // Lifting a block deletes its row (Q5, docs/decisions.md).
  const lifted = safetyAudit.blocks.lift(req.params.id);
  if (!lifted) return res.status(404).json({ error: 'BLOCK_NOT_FOUND' });
  broadcast('players');
  res.json({ lifted: blockView(lifted) });
});

// Newest first, paged by cursor (domains/platform/paging.mjs): { items, nextCursor }.
adminRouter.get('/moderation', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const out = safetyAudit.moderationLog.page(page);
  res.json({ items: out.items.map(moderationView), nextCursor: out.nextCursor });
});

// Thread audit — the "all communications logged" promise, made inspectable.
// Pages by cursor, most recently active first.
adminRouter.get('/channels', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number', 'number']); } catch (e) { return sendPageError(res, e); }
  const out = channels.page(page);
  res.json({ items: out.items.map((c) => ({ ...channelViewFor(c, 'org'), guardianId: c.guardianId })), nextCursor: out.nextCursor });
});

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
// Returns its context so the legacy admin verification route can keep claim provenance in sync.
const m14Ctx = registerM14({
  verification, unit,
  byId, players, guardians, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, users, orgs, app, orgRouter, playerRouter, guardianRouter, adminRouter,
  nextId, notify, ledgerAppend, broadcast, safetyAudit,
  findPlayer, isBlocked, moderateOrRefuse, playerViewForOrg, sessionFor,
  storage, mailer, orgSafe, recordActivity, revokeOrgUserAccess,
  grassrootsOrgOnly, guardianManagedOnly, safeguardingCertified,
  createSession, DATA_DIR,
});

// Canonical source-change events. Registered before the systems that write to
// it (the Passport preferences) and the system that reads it (Second Look),
// so a change carries the clock of the moment it happened rather than one
// borrowed from a record describing a different event.
const srcCtx = { nextId, safetyAudit }; // source changes are rows of source_changes, written through the repository
registerSourceChanges(srcCtx);

// Preferences, audit and fault injection. Registered here, after the routers
// exist and before the modules that emit notifications, so
// the preference gate is in place for every notify() call that follows.
m182Ctx = {
  byId, players, guardians, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, recruitmentReads, notifications, orgRouter, playerRouter, guardianRouter, findPlayer,
  // The same standing-gate composition m12/shared.mjs uses.
  orgCanSee: (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id),
  requireLead: (req, res) => {
    if (isLeadRole(req.orgUser?.role)) return true;
    res.status(403).json({ error: 'LEAD_REQUIRED', message: 'Only recruitment leads and directors can do this.' });
    return false;
  },
};
const prefsModule = registerNotificationPrefs(m182Ctx);
notificationAllows = prefsModule.allows;
registerAudit(m182Ctx);

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
  storage, m14: m14Ctx,
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
// An attributed review of a declared-only binding lands on the transaction's own representation row.
complianceDomain.transactionSeam.hooks.representationReviewed = transactionsDomain.representationReviewed;

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

// ------------------------------------------------- canonical Offer workflow
// The authoritative Offer domain. A formal decision to progress AUTHORISES
// considering an Offer and creates none; an explicit club act drafts one;
// issuing freezes an exact immutable revision and moves the case to
// `offer_made`; the recipient's own acceptance or decline — and nothing else
// — moves it to `offer_accepted` / `offer_declined`. It moves the case only
// through the ONE validator (with the real evidence provider) and the ONE
// status writer; it never writes `signed`, never touches the signings, never
// negotiates and never lets an agent act for a player. Registered after the
// Agent layers because it reads the integration seam (an agent's basis and
// scope) and the transactions' readiness seam, by reference.
m28Ctx = registerOffers({
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
});

// ----------------------------------------------- Signing & Contract Completion
// The ONE writer of the signings, of the lifecycle move to
// `signed` and of a player's `contractStatus` for a recruitment signing.
// Registered after the Offer module because a package is opened over an
// ACCEPTED Offer revision and read by reference; the Offer views get a
// read-only signing summary through a late-bound hook.
m29Ctx = registerSigning({
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
  evidence: { storeFile: m14Ctx.storeEvidenceFile, add: m14Ctx.addEvidence },
  faults: faultLayer,
});
m28Ctx.setSigningSummary?.(m29Ctx.summaryForOffer);

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
        suppressedByPreference: notificationsSuppressed.count,
        unknownTypes: Object.keys(m182Ctx.notificationUnknownTypes?.() ?? {}),
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
