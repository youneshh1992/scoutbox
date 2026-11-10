// ScoutBox sync backend.
// Every deck rule is enforced HERE, not in the frontends — the product's
// claims depend on the API refusing, not the UI hiding.

import express from 'express';
import { installAsyncErrorForwarding } from './domains/platform/asyncErrors.mjs';
// A rejected async handler answers 500 instead of ending the process.
installAsyncErrorForwarding();

import { reqText } from './domains/platform/input.mjs';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './seed.mjs';
import { openStore } from './store.mjs';
import { attachDataLayer } from './repositories/index.mjs';
import { createIdCounter } from './repositories/counters.mjs';
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
import { createOrgViews, createOrgSession, registerOrgAccount, registerClubDirectory } from './domains/identity/orgs.mjs';
import { registerPlayerSearch } from './domains/discovery/search.mjs';
import { registerFilmRoom } from './domains/discovery/filmRoom.mjs';
import { createRequestWriters, registerClubRequests, requestForRecipient } from './domains/recruitment/requests.mjs';
import { registerClubTrials } from './domains/recruitment/clubTrials.mjs';
import { registerLegacySigning } from './domains/recruitment/signings/legacy.mjs';
import { registerLedger, ledgerView } from './domains/recruitment/ledger.mjs';
import { registerGrassrootsClub, grassrootsOrgOnly } from './domains/development/grassrootsClub.mjs';
import { registerClubChecks } from './domains/verification/clubChecks.mjs';
import { createMfaGuards, requestInstrumentation } from './domains/enterprise/enterprise.mjs';
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
  moderateText,
  haversineKm,
  computeStreak,
} from './domain.mjs';
import { PLANS } from './catalogue.mjs';

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

// The organisation as the apps see it, and whether its safeguarding certification stands.
const { orgSafe, safeguardingCertified } = createOrgViews({ clubSetup, safetyAudit });

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

// One rate limiter for the whole server. Every limited action is named in RATE_LIMIT_POLICY with its window and
// scope, and the capability report says plainly that the memory provider counts per process.
const rateLimit = createRateLimiter();

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
const { orgRouter } = createOrgSession({ app, findOrg: byId.org, users, sessionFor });
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

// ------------------------------------------------------------- organisations
// The sign-in pickers, Grassroots registration and staff log-in (domains/identity/orgs.mjs). The MFA guards are
// shared with the MFA set-up routes (domains/enterprise/enterprise.mjs).
const mfaGuards = createMfaGuards();
registerOrgAccount({
  app, orgs, users, safetyAudit, findOrg: byId.org, unit, nextId, broadcast, createSession, loginLockedOut, noteLoginFailure,
  devLogins: DEV_LOGINS, devLoginRefused, mfaGuards, orgSafe, safeguardingCertified,
});

// ------------------------------------------------------------- club routes
// The one writer of a request row and of an accepted trial: the Contact, Trial and open-day flows and the Inbox's
// answers all go through them.
const { issueRecruitmentRequest, issueAcceptedTrial, contactReplyFrom } = createRequestWriters({
  recruitment, nextId, ledgerAppend, notify, broadcast, safeguardingCertified, moderateOrRefuse,
});
registerPlayerSearch({ orgRouter, players, safetyAudit, findPlayer, isBlocked, ledgerAppend, broadcast, nextId, playerViewForOrg });
registerClubRequests({ orgRouter, recruitment, findPlayer, isBlocked, moderateOrRefuse, rateLimit, issueRecruitmentRequest });
registerFilmRoom({ orgRouter, players, recruitment, safetyAudit, findPlayer, isBlocked, unit, ledgerAppend, notify, broadcast, playerViewForOrg });
const { checkSavedSearches } = registerSavedSearches({ byId, orgRouter, notify, nextId, playerViewForOrg, reqText, savedSearches: operations.savedSearches });
registerClubTrials({ orgRouter, recruitment, findPlayer, isBlocked, moderateOrRefuse, unit, nextId, ledgerAppend, notify, broadcast });
const { pathwayRecord, openTrialView } = registerGrassrootsClub({
  orgRouter, players, grassroots, clubSetup, transitionsVouches, signings: signingsFollowUps.signings, findPlayer, findOrg: byId.org,
  unit, seam, nextId, ledgerAppend, notify, broadcast, moderateOrRefuse, playerViewForOrg, recordActivity, canonicalContractFor,
  issueRecruitmentRequest,
});
registerClubChecks({ orgRouter, orgs, codes, clubSetup, mailer, rateLimit, unit, seam, broadcast });
registerLedger({
  orgRouter, safetyAudit, recruitment, signings: signingsFollowUps.signings, invoices: operations.invoices,
  reputationSeed: operations.reputationSeed, findPlayer, isBlocked,
});
registerClubDirectory({ app, orgs, trialsForOrg: (orgId) => recruitment.trials.forOrg(orgId), safeguardingCertified, pathwayRecord });

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
// Same module pattern under m13/.
const m13Ctx = registerM13({
  mfaGuards,
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
registerLegacySigning({
  orgRouter, signings: signingsFollowUps.signings, findPlayer, isBlocked, rateLimit, unit,
  recordCompletedSigning: signingsDomain.recordCompletedSigning, legacyRecordingBlocker: signingsDomain.legacyRecordingBlocker,
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
  app, playerRouter, guardianRouter, players, orgs, grassroots, clubSetup, transitionsVouches, findPlayer, findOrg: byId.org, unit, seam,
  nextId, broadcast, notify, ledgerAppend, mailer, guardianManagedOnly, recordActivity, publishedVouchesFor,
  scoutViewsOf: (playerId) => safetyAudit.ledger.countForPlayer(playerId, 'view'), pathwayRecord, openTrialView, safeguardingCertified, moderateOrRefuse,
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
