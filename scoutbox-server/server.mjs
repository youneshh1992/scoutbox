// ScoutBox sync backend (Milestone 2).
// Every deck rule is enforced HERE, not in the frontends — the product's
// claims depend on the API refusing, not the UI hiding.
//
// Storage is in-memory, seeded from seed.mjs (restart = reset). The API
// surface is designed so storage can swap to Postgres without changes.

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './seed.mjs';
import { openStore } from './store.mjs';
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

const PORT = process.env.PORT || 4000;
const db = buildSeed();

// ------------------------------------------------------------- persistence
// SQLite-backed snapshot store (store.mjs): the working set stays in memory,
// every save is an atomic transaction into data/scoutbox.db, and a legacy
// data/db.json is imported once on first boot. Saves are debounced and
// flushed on shutdown.
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const store = openStore(DATA_DIR);
let snapshotLoaded = false;
let snapshotIdCounter = 0; // applied when the id counter initialises below

function loadSnapshot() {
  try {
    const raw = store.load();
    if (!raw || !Array.isArray(raw.db?.players)) return;
    for (const key of Object.keys(db)) delete db[key];
    Object.assign(db, raw.db);
    snapshotIdCounter = Number(raw.idCounter) || 0;
    snapshotLoaded = true;
    console.log(`snapshot loaded (${store.engine}): ${db.players.length} players, ${db.ledger.length} ledger rows`);
  } catch (err) {
    console.error('snapshot load failed — running from seed:', err.message);
  }
}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      store.save({ savedAt: Date.now(), idCounter: currentIdCounter(), db });
    } catch (err) {
      console.error('snapshot save failed:', err.message);
    }
  }, 2000);
}

function persistNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    store.save({ savedAt: Date.now(), idCounter: currentIdCounter(), db });
  } catch (err) {
    console.error('snapshot save failed:', err.message);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { persistNow(); process.exit(0); });
}

loadSnapshot();

// Normalise media items (older shapes) + load the seeded sample clips.
for (const p of db.players) {
  for (const m of p.media) {
    m.views ??= 0;
    m.tags ??= {};       // tag → count (from scouts, aggregated anonymously)
    m.verifiedClip ??= null; // attendance id when footage is provably from a confirmed fixture
    m.url ??= null;
  }
  p.notificationPrefs ??= null;
  p.seasonHistory ??= [];
}
db.savedSearches ??= [];
db.signings ??= [];
db.pairingCodes ??= [];
db.sessions ??= [];        // bearer-token sessions (all roles)
db.outbox ??= [];          // mailer dev transport (+ delivery audit when live)
db.pushLog ??= [];         // push dev transport (+ delivery audit when live)
db.pushTokens ??= [];      // device push tokens, registered per user
db.invoices ??= [];        // billing records (success fees)
db.emailChallenges ??= []; // club email-domain verification codes
db.openTrials ??= [];      // grassroots open trial days + registrations
db.vouches ??= [];         // coach references (email-code verified)
db.matchdays ??= [];       // grassroots match-day logs (squad-wide attendance)
db.friendlies ??= [];      // club-to-club friendly-match board (local)
db.mediaBlobs ??= {};
for (const p of db.players) {
  p.firstTeamSeeker ??= false;
  p.programme ??= null;
}
for (const o of db.orgs) {
  if (o.level === 'grassroots') o.squad ??= [];
}

// ---------------------------------------------------- production adapters
const mailer = createMailer(db, (p) => nextId(p));
const pushSender = createPushSender(db, (p) => nextId(p));
const idv = createIdvProvider();
const billing = createBilling(db, (p) => nextId(p));
const storage = createStorage(DATA_DIR);

// Media blobs migrate out of the database onto object storage (local disk in
// dev). The db keeps only ids; /media/:id streams from storage.
for (const [id, blob] of Object.entries(db.mediaBlobs)) {
  if (blob?.dataUrl) storage.saveDataUrl(id, blob.dataUrl);
}
db.mediaBlobs = {};

if (!snapshotLoaded) {
  const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
  const SAMPLE_CLIPS = [
    { file: 'clip-sprint.webm', playerId: 'pl-adeyemi', title: 'Sprint & finishing session', verify: true },
    { file: 'clip-passing.webm', playerId: 'pl-carvalho', title: 'Passing range compilation', verify: true },
    { file: 'clip-wingplay.webm', playerId: 'pl-guni', title: 'U15 highlights — wing play', verify: true },
  ];
  for (const sample of SAMPLE_CLIPS) {
    try {
      const data = fs.readFileSync(path.join(ASSETS_DIR, sample.file));
      const player = db.players.find((p) => p.id === sample.playerId);
      const media = player?.media.find((m) => m.title === sample.title);
      if (!media) continue;
      storage.saveDataUrl(media.id, `data:video/webm;base64,${data.toString('base64')}`);
      media.url = `/media/${media.id}`;
      if (sample.verify && player.attendance[0]) media.verifiedClip = player.attendance[0].id;
    } catch {
      // assets optional — Film Room just starts empty without them
    }
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' })); // media uploads travel as data URLs

// ---------------------------------------------------------------- live sync
const sseClients = new Set();

function broadcast(event, payload = {}) {
  if (event !== 'typing') persist(); // every broadcast (bar ephemeral typing) follows a state change
  const msg = `data: ${JSON.stringify({ event, ...payload, ts: Date.now() })}\n\n`;
  for (const res of sseClients) res.write(msg);
}

app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ event: 'connected', ts: Date.now() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ------------------------------------------------------------------ helpers
let idCounter = Math.max(1000, snapshotIdCounter);
const nextId = (prefix) => {
  persist(); // any id mint means state changed somewhere
  return `${prefix}-${++idCounter}`;
};
function currentIdCounter() { return idCounter; }

function findPlayer(id) {
  return db.players.find((p) => p.id === id);
}

function ledgerAppend(entry) {
  // Discovery Ledger is append-only; nothing in this file ever mutates or
  // deletes an entry after this push.
  const row = { id: nextId('led'), ts: Date.now(), ...entry };
  db.ledger.push(row);
  broadcast('ledger', { type: row.type, playerId: row.playerId });
  return row;
}

function isBlocked(playerId, orgId) {
  return db.blocks.some((b) => b.playerId === playerId && b.orgId === orgId);
}

// -------------------------------------------------------------- sessions
// Real sessions: logins mint a bearer token; every authenticated route
// resolves the caller from the token. Nothing trusts a client-sent id.
function createSession(kind, refId, extra = {}) {
  const token = newToken();
  db.sessions.push({ token, kind, refId, ...extra, createdAt: Date.now() });
  persist();
  return token;
}

function sessionFor(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  return db.sessions.find((s) => s.token === header.slice(7)) ?? null;
}

app.post('/auth/logout', (req, res) => {
  const session = sessionFor(req);
  if (session) {
    db.sessions = db.sessions.filter((s) => s !== session);
    persist();
  }
  res.json({ ok: true });
});

// Brute-force protection on every credential-shaped endpoint.
const authLimiter = makeRateLimiter({ windowMs: 60_000, max: 40, bucket: 'auth' });
app.use('/auth', authLimiter);

// ------------------------------------------------------------ notifications
// In-app notification feed. audience = {kind: 'player'|'guardian'|'org_user', id}.
// (Push / email delivery is a production integration behind this same record.)
// Quiet hours + the minors' school-hours mute apply to PUSH delivery: the
// in-app feed always receives the record, but `deferredPush` marks anything
// that production push infra must hold back.
function pushDeferred(audience, now = new Date()) {
  let prefs = null;
  let minor = false;
  if (audience.kind === 'player') {
    const p = findPlayer(audience.id);
    prefs = p?.notificationPrefs;
    minor = p ? !isAdult(p) : false;
  } else if (audience.kind === 'guardian') {
    prefs = db.guardians.find((g) => g.id === audience.id)?.notificationPrefs;
  }
  const minutes = now.getHours() * 60 + now.getMinutes();
  const schoolMute = prefs?.schoolHoursMute ?? minor; // minors muted in school hours by default
  const day = now.getDay();
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

function notify(audience, type, text, refId = null) {
  const n = { id: nextId('ntf'), ts: Date.now(), audience, type, text, refId, read: false, deferredPush: pushDeferred(audience) };
  db.notifications.push(n);
  // Push delivery honours quiet hours / school-hours mute; the in-app feed
  // above always keeps the record either way.
  if (!n.deferredPush) void pushSender.send(audience, 'ScoutBox', text);
  broadcast('notify', { audienceKind: audience.kind, audienceId: audience.id });
  return n;
}

function notificationsFor(kind, id) {
  return db.notifications.filter((n) => n.audience.kind === kind && n.audience.id === id).slice().reverse();
}

function markNotificationsRead(kind, id) {
  for (const n of db.notifications) {
    if (n.audience.kind === kind && n.audience.id === id) n.read = true;
  }
}

// ---------------------------------------------------------------- channels
// A channel is the ONLY conversation surface, and it exists solely because a
// request was accepted. For minors the counterparty is the guardian — the
// child is never in the thread. Every message is moderated and logged.
function openChannel(request) {
  const channel = {
    id: nextId('chan'),
    requestId: request.id,
    playerId: request.playerId,
    playerName: request.playerName,
    orgId: request.orgId,
    orgName: request.orgName,
    orgVerified: request.orgVerified,
    scoutName: request.scoutName,
    scoutRole: request.scoutRole,
    counterparty: request.routedTo, // 'player' | 'guardian'
    guardianId: request.guardianId,
    createdAt: Date.now(),
    messages: [],
    // Read receipts: last time each side opened the thread.
    readBy: { org: null, counterparty: null },
  };
  db.channels.push(channel);
  return channel;
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

function postMessage(channel, sender, text, attachment = null) {
  const msg = { id: nextId('msg'), ts: Date.now(), sender, text, attachment };
  channel.messages.push(msg);
  ledgerAppend({ type: 'message', playerId: channel.playerId, orgId: channel.orgId, orgName: channel.orgName, userId: sender.kind === 'org_user' ? sender.id : null, scoutName: sender.name });
  const recipient = sender.kind === 'org_user'
    ? channel.counterparty === 'guardian'
      ? { kind: 'guardian', id: channel.guardianId }
      : { kind: 'player', id: channel.playerId }
    : { kind: 'org_user', id: channel.orgUserIdForNotify ?? null };
  if (sender.kind !== 'org_user') {
    // notify every org user who has messaged or created the request
    const userIds = new Set([...channel.messages.filter((m) => m.sender.kind === 'org_user').map((m) => m.sender.id)]);
    const req = db.requests.find((r) => r.id === channel.requestId);
    if (req) userIds.add(req.userId);
    for (const uid of userIds) {
      if (uid) notify({ kind: 'org_user', id: uid }, 'message', `${sender.name} replied in the ${channel.playerName} thread.`, channel.id);
    }
  } else if (recipient.id) {
    notify(recipient, 'message', `${channel.orgName} (${channel.scoutRole}) sent a message.`, channel.id);
  }
  broadcast('messages', { channelId: channel.id });
  return msg;
}

// Channel view without internal ids the caller shouldn't hold.
function channelViewFor(channel, viewer) {
  const { orgId, guardianId, ...rest } = channel;
  return { ...rest, ...(viewer === 'org' ? { orgId } : {}) };
}

// Football activity feeds the streak/weekly-goal habit loop.
function recordActivity(player) {
  player.activityLog ??= [];
  player.activityLog.push(Date.now());
  refreshJourneyBadges(player);
}

// Grassroots journey badges: awarded automatically as the record grows.
// Level-up moments are handled at the signing itself.
function refreshJourneyBadges(player) {
  if (player.level === 'pro') return;
  const earned = earnedGrassrootsBadges(player, { streak: computeStreak(player.activityLog) });
  for (const badge of earned) {
    if (!player.badges.includes(badge)) {
      player.badges.push(badge);
      notify({ kind: 'player', id: player.id }, 'badge', `🏅 Badge earned: ${badge}. It's on your profile — recognition that never depends on being scouted.`, player.id);
    }
  }
}

function publishedVouchesFor(playerId) {
  return db.vouches
    .filter((v) => v.playerId === playerId && v.status === 'published')
    .map(({ coachEmail, code, ...visible }) => visible);
}

// Safeguarding certification is EARNED and losable: verification + signed
// contract + no unresolved urgent report against the org.
function safeguardingCertified(org) {
  if (!org.verified || !org.safeguardingContractSigned) return false;
  return !db.reports.some((r) => r.targetOrgId === org.id && r.urgent && r.status === 'pending_review');
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
  const events = db.ledger.filter((l) => l.playerId === playerId && INSIGHT_TYPES.includes(l.type));
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
    db.moderationLog.push({ id: nextId('mod'), ts: Date.now(), context, flags: check.flags, severity: check.severity, excerpt: String(text).slice(0, 140) });
    // Grooming-pattern hits don't just block — they escalate to a human
    // immediately as an urgent auto-report against the sender.
    if (check.severity === 'grooming') {
      db.reports.push({
        id: nextId('rep'), ts: Date.now(), by: 'system', byId: 'moderation',
        targetKind: context.orgId ? 'club' : 'player', targetOrgId: context.orgId ?? null,
        reason: `Automatic escalation: grooming-pattern language blocked (${check.flags.join(', ')}) in ${context.kind}.`,
        urgent: true, status: 'pending_review', outcome: null, resolvedAt: null,
      });
    }
    persist();
    res.status(400).json({
      error: 'MODERATION_BLOCKED',
      message: 'This text was blocked by moderation: personal contact details and off-platform contact are not allowed.',
      flags: check.flags,
    });
    return false;
  }
  return true;
}

// Public view of a player for a given org. Applies minor-visibility rules,
// guardian-managed contact, and player/guardian-controlled medical sharing.
function playerViewForOrg(player, org) {
  if (!visibleToOrg(player, org)) return null;
  if (isBlocked(player.id, org.id)) return null;
  const { medical, guardianId, password, activityLog, ...rest } = player;
  const minor = !isAdult(player);
  const view = {
    ...rest,
    age: ageOn(player.dob),
    trustScore: computeTrustScore(player),
    guardianManaged: minor,
    medical: medical.shared
      ? medical
      : { shared: false, records: [], conditionStatus: 'not_shared', note: 'Medical data is player-controlled and has not been shared.' },
  };
  if (minor) {
    // Privacy for minors: no city, no exact date of birth, no direct channel.
    view.city = '';
    view.dob = null;
    view.contactPolicy = 'guardian_only';
  }
  if ((org.level ?? null) === 'grassroots') {
    // Grassroots is semi-pro and below: the pro-market surface (Academy+
    // cohort, market value, agents) does not exist on this platform.
    delete view.academyPlus;
    delete view.marketValueRange;
    delete view.agentName;
    delete view.contractUntil;
    view.distanceKm = Math.round(haversineKm(org.location, player.location) * 10) / 10;
    view.firstTeamSeeker = !!player.firstTeamSeeker; // Grassroots' own cohort
  }
  // Coach references travel with grassroots-journey players everywhere.
  if (player.level !== 'pro') view.vouches = publishedVouchesFor(player.id);
  delete view.programme;
  delete view.location; // coordinates never leave the server
  return view;
}

// -------------------------------------------------------------------- meta
app.get('/health', (_req, res) => res.json({ ok: true, service: 'scoutbox-server', milestone: 2 }));

app.get('/meta', (_req, res) => {
  res.json({
    adultAges: { note: 'age of majority per country; DEFAULT applies otherwise' },
    plans: db.plans,
    positions: ['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'],
  });
});

// ------------------------------------------------------------- player auth
// Real sessions: signup/login/pair mint a bearer token. New accounts require
// a password (scrypt-hashed); pre-M7 seed identities carry no password and
// stay open as demo logins — production seeds always set one.

// Self sign-up is adults only. Under-18 accounts are OWNED by a verified
// guardian and can only be created through the guardian flow below — the API
// itself refuses a minor self-signup.
app.post('/auth/player/signup', (req, res) => {
  const { name, dob, country = 'GB', position, foot, password } = req.body || {};
  if (!name || !dob) return res.status(400).json({ error: 'NAME_AND_DOB_REQUIRED' });
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
    city: req.body.city || '',
    position: position || null,
    foot: foot || null,
    heightCm: req.body.heightCm || null,
    weightKg: req.body.weightKg || null,
    stats: null,
    academyPlus: false,
    badges: [],
    availability: 'not_seeking',
    contractStatus: 'unknown',
    identityVerified: false,
    attendance: [],
    timeline: [],
    media: [],
    trialReports: [],
    drills: [],
    guardianId: null,
    squadNumber: null,
    contractUntil: null,
    marketValueRange: null,
    agentName: null,
    createdAt: Date.now(),
    password: hashPassword(password),
    level: 'amateur',
    // Optional coordinates: without them the player simply is not visible to
    // grassroots clubs (the radius rule fails closed, never open).
    location: typeof req.body.lat === 'number' && typeof req.body.lng === 'number'
      ? { lat: req.body.lat, lng: req.body.lng } : null,
    medical: { shared: false, records: [], conditionStatus: 'unknown' },
  };
  db.players.push(p);
  checkSavedSearches(p);
  broadcast('players');
  const { password: _pw, ...safe } = p;
  res.status(201).json({ playerId: p.id, player: safe, token: createSession('player', p.id) });
});

app.post('/auth/player/login', (req, res) => {
  const p = findPlayer(req.body?.playerId);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (p.password) {
    const check = verifyPassword(req.body?.password ?? '', p.password);
    if (!check) return res.status(401).json({ error: 'BAD_PASSWORD', message: 'This profile is password-protected.' });
    if (check === 'upgrade') p.password = hashPassword(req.body.password); // migrate legacy plain-text
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
// Parents own every under-18 account. ID verification and the safeguarding
// disclaimer are hard gates BEFORE any child profile can exist.

app.post('/auth/guardian/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !email.includes('@')) return res.status(400).json({ error: 'NAME_AND_EMAIL_REQUIRED' });
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'PASSWORD_REQUIRED', message: 'Pick a password of at least 8 characters.' });
  }
  if (db.guardians.some((x) => x.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'EMAIL_IN_USE', message: 'A guardian account with this email already exists — log in instead.' });
  }
  const g = {
    id: nextId('gd'),
    name,
    email,
    password: hashPassword(password),
    emailVerified: false,
    emailCode: randomCode(6),
    idVerified: false,
    disclaimerAccepted: false,
    childIds: [],
  };
  db.guardians.push(g);
  await mailer.send({
    to: email,
    subject: 'Verify your ScoutBox guardian account',
    text: `Hi ${name},\n\nYour ScoutBox verification code is ${g.emailCode}.\n\nGuardian accounts own every under-18 profile on ScoutBox — verifying your email is the first of the safeguarding gates (email → ID → disclaimer) before any child profile can exist.`,
  });
  const { password: _pw, emailCode: _c, ...safe } = g;
  res.status(201).json({
    guardianId: g.id, guardian: safe, token: createSession('guardian', g.id), emailVerificationSent: true,
    // Dev transport has no real inbox — surface the code so the flow can
    // complete. Never present when a live mail provider is configured.
    ...(mailer.transport === 'dev-outbox' ? { devEmailCode: g.emailCode } : {}),
  });
});

app.post('/auth/guardian/verify-email', (req, res) => {
  const { guardianId, code } = req.body || {};
  const g = db.guardians.find((x) => x.id === guardianId);
  if (!g) return res.status(404).json({ error: 'GUARDIAN_NOT_FOUND' });
  if (g.emailVerified) return res.json({ emailVerified: true });
  if (!code || String(code).trim().toUpperCase() !== g.emailCode) {
    return res.status(400).json({ error: 'CODE_INVALID', message: 'That code doesn\'t match — check the email we sent you.' });
  }
  g.emailVerified = true;
  g.emailCode = null;
  persist();
  res.json({ emailVerified: true });
});

app.post('/auth/guardian/login', (req, res) => {
  const g = db.guardians.find((x) => x.id === req.body?.guardianId || x.email === req.body?.email);
  if (!g) return res.status(404).json({ error: 'GUARDIAN_NOT_FOUND' });
  if (g.password) {
    const check = verifyPassword(req.body?.password ?? '', g.password);
    if (!check) return res.status(401).json({ error: 'BAD_PASSWORD', message: 'This account is password-protected.' });
    if (check === 'upgrade') g.password = hashPassword(req.body.password);
  }
  const { password: _pw, emailCode: _c, ...safe } = g;
  res.json({ guardianId: g.id, guardian: safe, token: createSession('guardian', g.id) });
});

function guardianAuth(req, res, next) {
  const session = sessionFor(req);
  const g = session?.kind === 'guardian' ? db.guardians.find((x) => x.id === session.refId) : null;
  if (!g) return res.status(401).json({ error: 'GUARDIAN_AUTH_REQUIRED', message: 'Log in again — this session is no longer valid.' });
  req.guardian = g;
  next();
}

const guardianRouter = express.Router();
app.use('/guardian', guardianAuth, guardianRouter);

// Prototype ID verification: an attestation endpoint. Production integrates a
// document + liveness IDV provider behind this same call.
guardianRouter.post('/verify-id', async (req, res) => {
  const { documentType, documentRef } = req.body || {};
  if (!documentType || !documentRef) {
    return res.status(400).json({ error: 'DOCUMENT_REQUIRED', message: 'ID verification needs a document type and reference.' });
  }
  // Runs through the IDV adapter: instant attestation in dev, a document +
  // liveness provider (ONFIDO_API_TOKEN) in production — same call either way.
  const result = await idv.verify({ name: req.guardian.name, documentType, documentRef });
  if (!result.approved) {
    return res.status(422).json({ error: 'IDV_REJECTED', message: 'Identity verification did not pass — check the document details.' });
  }
  req.guardian.idVerified = true;
  req.guardian.idvReference = result.reference;
  // Every check lands in the admin IDV queue for audit — and can be revoked there.
  db.idvQueue ??= [];
  db.idvQueue.push({
    id: nextId('idv'), guardianId: req.guardian.id, guardianName: req.guardian.name,
    documentType, documentRef: result.document.refLast4, provider: result.provider,
    reference: result.reference, ts: Date.now(), status: 'approved',
  });
  res.json({ idVerified: true, reference: result.reference });
});

guardianRouter.post('/disclaimer', (req, res) => {
  if (req.body?.accepted !== true) {
    return res.status(400).json({ error: 'DISCLAIMER_NOT_ACCEPTED' });
  }
  req.guardian.disclaimerAccepted = true;
  res.json({ disclaimerAccepted: true });
});

function guardianView(g) {
  const { password, emailCode, ...safe } = g;
  return safe;
}

guardianRouter.get('/me', (req, res) => res.json(guardianView(req.guardian)));

guardianRouter.get('/children', (req, res) => {
  res.json(
    req.guardian.childIds
      .map((id) => findPlayer(id))
      .filter(Boolean)
      .map(({ password, ...p }) => ({ ...p, age: ageOn(p.dob), trustScore: computeTrustScore(p), trust: trustBreakdown(p) }))
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
  if (ageOn(dob) >= adultAgeFor(country)) {
    return res.status(400).json({ error: 'NOT_A_MINOR', message: 'Adults create their own account with player sign-up.' });
  }
  const p = {
    id: nextId('pl'),
    name,
    dob,
    country,
    city: '',
    guardianId: req.guardian.id,
    position: position || null,
    foot: foot || null,
    heightCm: heightCm || null,
    weightKg: weightKg || null,
    stats: null,
    academyPlus: false,
    badges: [],
    availability: 'not_seeking',
    contractStatus: 'unknown',
    identityVerified: false,
    attendance: [],
    timeline: [],
    media: [],
    trialReports: [],
    drills: [],
    squadNumber: null,
    contractUntil: null,
    marketValueRange: null,
    agentName: null,
    createdAt: Date.now(),
    password: null,
    level: 'amateur',
    location: typeof req.body.lat === 'number' && typeof req.body.lng === 'number'
      ? { lat: req.body.lat, lng: req.body.lng } : null,
    medical: { shared: false, records: [], conditionStatus: 'unknown' },
  };
  db.players.push(p);
  req.guardian.childIds.push(p.id);
  checkSavedSearches(p);
  broadcast('players');
  res.status(201).json({ playerId: p.id, player: p });
});

// Scout Inbox for minors lives with the GUARDIAN. Club-first identity:
// the parent sees the verified club and the sender's verified role.
guardianRouter.get('/inbox', (req, res) => {
  res.json(
    db.requests
      .filter((r) => r.routedTo === 'guardian' && req.guardian.childIds.includes(r.playerId))
      .map(({ orgId, userId, ...visible }) => visible)
      .slice()
      .reverse()
  );
});

guardianRouter.post('/requests/:id/respond', (req, res) => {
  const request = db.requests.find(
    (r) => r.id === req.params.id && r.routedTo === 'guardian' && req.guardian.childIds.includes(r.playerId)
  );
  if (!request) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'ALREADY_RESPONDED' });
  const child = findPlayer(request.playerId);
  const { accept, chosenSlot } = req.body || {};
  request.status = accept ? 'accepted' : 'declined';
  request.respondedAt = Date.now();
  request.respondedBy = 'guardian';

  if (accept) {
    // The conversation that opens is between adults: club staff and guardian.
    const channel = openChannel(request);
    request.contactChannel = channel.id;
    ledgerAppend({ type: `${request.type}_accepted_by_guardian`, playerId: child.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    if (request.type === 'trial') {
      const details = request.trialDetails ?? {};
      const slotOk = chosenSlot && (chosenSlot === details.proposedDate || (details.altSlots ?? []).includes(chosenSlot));
      const trialDate = slotOk ? chosenSlot : details.proposedDate ?? null;
      db.trials.push({
        id: nextId('trial'),
        requestId: request.id,
        playerId: child.id,
        playerName: child.name,
        orgId: request.orgId,
        orgName: request.orgName,
        scoutName: request.scoutName,
        acceptedAt: Date.now(),
        guardianApproved: true,
        proposedDate: trialDate,
        venue: details.venue ?? null,
        notes: details.notes ?? '',
        // The mandatory report is due 7 days after the trial (or acceptance).
        reportDueAt: (trialDate ? new Date(trialDate).getTime() : Date.now()) + 7 * 24 * 3600 * 1000,
        status: 'awaiting_report',
      });
    }
    notify({ kind: 'org_user', id: request.userId }, 'accepted', `The guardian of ${child.name} accepted your ${request.type} request — thread open.`, request.contactChannel);
    notify({ kind: 'player', id: child.id }, 'update', `Your parent/guardian accepted the ${request.type} with ${request.orgName}.`, request.id);
  } else {
    ledgerAppend({ type: `${request.type}_declined_by_guardian`, playerId: child.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    notify({ kind: 'org_user', id: request.userId }, 'declined', `The guardian of ${child.name} declined your ${request.type} request.`, request.id);
    notify({ kind: 'player', id: child.id }, 'update', `Your parent/guardian declined the ${request.type} with ${request.orgName}.`, request.id);
  }
  broadcast('requests', { playerId: child.id });
  const { orgId, userId, ...visible } = request;
  res.json(visible);
});

// Guardian-side message threads (adult-to-adult, moderated, logged).
guardianRouter.get('/channels', (req, res) => {
  res.json(db.channels.filter((c) => c.guardianId === req.guardian.id).map((c) => channelViewFor(c, 'guardian')));
});

guardianRouter.post('/channels/:id/messages', (req, res) => {
  const channel = db.channels.find((c) => c.id === req.params.id && c.guardianId === req.guardian.id);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
  if (!moderateOrRefuse(res, text, { kind: 'guardian_message', channelId: channel.id })) return;
  const att = buildAttachment(channel, req.body, 'guardian');
  if (!att.ok) return res.status(400).json({ error: att.error });
  res.status(201).json(postMessage(channel, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name }, text.trim(), att.attachment));
});

guardianRouter.post('/channels/:id/read', (req, res) => {
  const channel = db.channels.find((c) => c.id === req.params.id && c.guardianId === req.guardian.id);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  channel.readBy.counterparty = Date.now();
  broadcast('messages', { channelId: channel.id });
  res.json({ readBy: channel.readBy });
});

guardianRouter.post('/channels/:id/typing', (req, res) => {
  const channel = db.channels.find((c) => c.id === req.params.id && c.guardianId === req.guardian.id);
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
        newRequests: db.requests.filter((r) => r.playerId === c.id && r.createdAt >= week).length,
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
  child.availability = availability;
  broadcast('players', { playerId: child.id });
  res.json({ availability: child.availability });
});

// Co-guardian: a second parent/guardian sharing the same children.
guardianRouter.post('/coguardian', (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'NAME_AND_EMAIL_REQUIRED' });
  const co = {
    id: nextId('gd'),
    name,
    email,
    idVerified: false, // must still verify + accept before acting
    disclaimerAccepted: false,
    childIds: [...req.guardian.childIds],
    coGuardianOf: req.guardian.id,
  };
  db.guardians.push(co);
  req.guardian.coGuardians = [...(req.guardian.coGuardians ?? []), { id: co.id, name, email }];
  res.status(201).json({ guardianId: co.id, note: 'The co-guardian must verify their ID and accept the disclaimer before they can act.' });
});

guardianRouter.get('/notifications', (req, res) => res.json(notificationsFor('guardian', req.guardian.id)));
guardianRouter.post('/notifications/read', (req, res) => {
  markNotificationsRead('guardian', req.guardian.id);
  res.json({ ok: true });
});

guardianRouter.get('/reports', (req, res) => {
  res.json(db.reports.filter((r) => r.by === 'guardian' && r.byId === req.guardian.id).slice().reverse());
});

guardianRouter.get('/children/:id/insights', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  res.json(insightsFor(child.id));
});

// All communications are logged, and the parent can read the full log.
guardianRouter.get('/log', (req, res) => {
  res.json(db.ledger.filter((l) => req.guardian.childIds.includes(l.playerId)).slice().reverse());
});

// Guardian controls the child's medical sharing and availability.
guardianRouter.post('/children/:id/medical/share', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  child.medical.shared = !!req.body?.shared;
  broadcast('players', { playerId: child.id });
  res.json({ shared: child.medical.shared });
});

guardianRouter.post('/report', (req, res) => handleReport(req, res, { by: 'guardian', byId: req.guardian.id }));
guardianRouter.post('/block', (req, res) => {
  const { orgId, playerId, reason } = req.body || {};
  const childId = playerId && req.guardian.childIds.includes(playerId) ? playerId : req.guardian.childIds[0];
  if (!orgId || !childId) return res.status(400).json({ error: 'ORG_AND_CHILD_REQUIRED' });
  db.blocks.push({ id: nextId('blk'), playerId: childId, orgId, by: 'guardian', reason: reason || '', ts: Date.now() });
  ledgerAppend({ type: 'org_blocked_by_guardian', playerId: childId, orgId, orgName: db.orgs.find((o) => o.id === orgId)?.name ?? orgId, userId: null, scoutName: 'guardian' });
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
  const report = {
    id: nextId('rep'),
    ts: Date.now(),
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
  db.reports.push(report);
  // Reports now land in the REAL review queue: the trust-and-safety admin
  // console resolves them (POST /admin/reports/:id/resolve) and the reporter
  // is notified with the outcome. No more auto-resolve timer.
  if (report.urgent && targetOrgId) {
    // Immediate suspension pending review: the org loses access to the
    // reporter's players and its pending requests to them freeze.
    const playerIds = actor.by === 'guardian'
      ? db.guardians.find((g) => g.id === actor.byId)?.childIds ?? []
      : actor.by === 'player' ? [actor.byId] : [];
    for (const pid of playerIds) {
      db.blocks.push({ id: nextId('blk'), playerId: pid, orgId: targetOrgId, by: actor.by, reason: 'suspended_pending_review', ts: Date.now() });
      for (const r of db.requests) {
        if (r.playerId === pid && r.orgId === targetOrgId && r.status === 'pending') r.status = 'suspended';
      }
    }
    broadcast('players');
  }
  res.status(201).json({ reportId: report.id, status: report.status, suspended: !!(report.urgent && targetOrgId) });
}

// ---------------------------------------------------------------- org auth
app.get('/orgs', (req, res) => {
  let list = db.orgs;
  // Platform separation starts at the login screen: the Grassroots app lists
  // only grassroots clubs, the main app never lists them.
  if (req.query.platform === 'grassroots') list = list.filter((o) => o.level === 'grassroots');
  else if (req.query.platform === 'main') list = list.filter((o) => o.level !== 'grassroots');
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
  const { name, country = 'GB', city, lat, lng, federation, registrationId, scoutName, role } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'NAME_REQUIRED' });
  if (!federation || !registrationId) {
    return res.status(400).json({ error: 'FEDERATION_REQUIRED', message: 'Grassroots clubs must hold a federation registration — name the federation and your registration id.' });
  }
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'LOCATION_REQUIRED', message: 'The 50km scouting radius is measured from your ground — a location is required.' });
  }
  if (!scoutName || !scoutName.trim()) return res.status(400).json({ error: 'SCOUT_NAME_REQUIRED' });
  const org = {
    id: nextId('org'),
    name: name.trim(),
    type: 'club',
    level: 'grassroots',
    location: { lat, lng, city: city || '' },
    federationRef: { federation: String(federation), registrationId: String(registrationId) },
    plan: 'Grassroots',
    trustedPartner: false,
    country,
    verified: false,
    verifiedDomain: null,
    safeguardingContractSigned: false,
  };
  db.orgs.push(org);
  const user = { id: nextId('usr'), orgId: org.id, name: scoutName.trim(), role: (role || 'Manager').trim(), createdAt: Date.now() };
  db.users.push(user);
  persist();
  broadcast('orgs');
  res.status(201).json({
    userId: user.id, role: user.role, org: { ...org, safeguardingCertified: safeguardingCertified(org) },
    token: createSession('org', org.id, { userId: user.id }),
    note: 'Registered. Adults within 50km are visible now; under-18 visibility needs verification + the safeguarding contract, reviewed by Trust & Safety.',
  });
});

app.post('/auth/org/login', (req, res) => {
  const { orgId, scoutName, role, platform } = req.body || {};
  const org = db.orgs.find((o) => o.id === orgId);
  if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
  // Hard platform separation: a grassroots club exists only on ScoutBox
  // Grassroots; every other org exists only on ScoutBox. No crossover.
  const wantsGrassroots = platform === 'grassroots';
  if (org.level === 'grassroots' && !wantsGrassroots) {
    return res.status(403).json({ error: 'GRASSROOTS_PLATFORM_ONLY', message: 'This club is registered on ScoutBox Grassroots — log in there.' });
  }
  if (org.level !== 'grassroots' && wantsGrassroots) {
    return res.status(403).json({ error: 'PLATFORM_MISMATCH', message: 'ScoutBox Grassroots is for federation-registered grassroots clubs only.' });
  }
  if (!scoutName || !scoutName.trim()) {
    // Accountability by user: no anonymous / shared workspace access.
    return res.status(400).json({ error: 'SCOUT_NAME_REQUIRED', message: 'Every session is attributed to a named individual.' });
  }
  let user = db.users.find((u) => u.orgId === orgId && u.name.toLowerCase() === scoutName.trim().toLowerCase());
  if (!user) {
    user = { id: nextId('usr'), orgId, name: scoutName.trim(), role: (role || 'Scout').trim(), createdAt: Date.now() };
    db.users.push(user);
  } else if (role) {
    user.role = role.trim();
  }
  res.json({
    userId: user.id, role: user.role,
    org: { ...org, safeguardingCertified: safeguardingCertified(org) },
    token: createSession('org', org.id, { userId: user.id }),
  });
});

// Accountability by user: sessions are minted per INDIVIDUAL scout at login —
// the token resolves to both the org and the named user, so shared/anonymous
// workspace access is structurally impossible.
function orgAuth(req, res, next) {
  const session = sessionFor(req);
  if (session?.kind !== 'org') return res.status(401).json({ error: 'ORG_AUTH_REQUIRED', message: 'Log in again — this session is no longer valid.' });
  const org = db.orgs.find((o) => o.id === session.refId);
  if (!org) return res.status(401).json({ error: 'ORG_AUTH_REQUIRED' });
  const user = db.users.find((u) => u.id === session.userId && u.orgId === org.id);
  if (!user) return res.status(401).json({ error: 'USER_UNKNOWN' });
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
  let list = db.players
    .map((p) => playerViewForOrg(p, req.org)) // wall + verification + blocks, at the source
    .filter(Boolean);

  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter(
      (p) => p.name.toLowerCase().includes(needle) || (p.city || '').toLowerCase().includes(needle) || (p.country || '').toLowerCase().includes(needle)
    );
  }
  if (position) list = list.filter((p) => p.position === position);
  if (availability) list = list.filter((p) => p.availability === availability);
  if (academyPlus === 'true') list = list.filter((p) => p.academyPlus);
  if (country) list = list.filter((p) => p.country === country);
  if (ageGroup === 'u16') list = list.filter((p) => p.age < 16);
  if (ageGroup === 'u18') list = list.filter((p) => p.age < 18);
  if (ageGroup === '18-21') list = list.filter((p) => p.age >= 18 && p.age <= 21);
  if (ageGroup === 'senior') list = list.filter((p) => p.age >= 22);
  if (newDays) {
    const cutoff = Date.now() - Number(newDays) * 24 * 3600 * 1000;
    list = list.filter((p) => p.createdAt && p.createdAt >= cutoff);
  }

  if (req.org.level === 'grassroots') {
    // First Team Seekers surface first (need-based, never purchasable),
    // then nearest ground, then trust.
    list.sort((a, b) =>
      (b.firstTeamSeeker ? 1 : 0) - (a.firstTeamSeeker ? 1 : 0) ||
      (a.distanceKm ?? 999) - (b.distanceKm ?? 999) ||
      b.trustScore - a.trustScore);
  } else {
    // Academy+ is a boosted cohort: opted-in players surface first.
    list.sort((a, b) => (b.academyPlus ? 1 : 0) - (a.academyPlus ? 1 : 0) || b.trustScore - a.trustScore);
  }
  res.json(list);
});

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
  const similar = db.players
    .filter((c) => c.id !== p.id && visibleToOrg(c, req.org) && !isBlocked(c.id, req.org.id))
    .map((c) => ({ playerId: c.id, name: c.name, position: c.position, score: similarityScore(p, c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const archetypes = db.archetypes
    .map((a) => ({ archetypeId: a.id, label: a.label, score: similarityScore(p, a) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const orgNotes = (db.orgNotes ?? []).filter((n) => n.orgId === req.org.id && n.playerId === p.id).slice().reverse();
  res.json({ ...view, orgNotes, similarPlayers: { note: 'Statistical similarity — a lead, not a verdict.', players: similar, archetypes } });
});

// Internal scouting notes — shared inside the org, never visible to the
// player or any other organisation.
orgRouter.post('/players/:id/notes', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p || !visibleToOrg(p, req.org)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
  db.orgNotes ??= [];
  const note = { id: nextId('note'), orgId: req.org.id, playerId: p.id, userId: req.orgUser.id, scoutName: req.orgUser.name, text: text.trim(), ts: Date.now() };
  db.orgNotes.push(note);
  broadcast('players', { playerId: p.id });
  res.status(201).json(note);
});

// "More like this" — the similarity engine as a search entry point.
orgRouter.get('/players/:id/morelike', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p || !visibleToOrg(p, req.org)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  const ranked = db.players
    .filter((c) => c.id !== p.id && visibleToOrg(c, req.org) && !isBlocked(c.id, req.org.id))
    .map((c) => ({ ...playerViewForOrg(c, req.org), similarity: similarityScore(p, c) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10);
  res.json({ base: { id: p.id, name: p.name, position: p.position }, players: ranked });
});

for (const action of ['save', 'shortlist']) {
  orgRouter.post(`/players/:id/${action}`, (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
    const row = ledgerAppend({ type: action, playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    res.status(201).json({ ok: true, ledgerId: row.id });
  });
}

orgRouter.get('/shortlist', (req, res) => {
  const ids = new Set(db.ledger.filter((l) => l.orgId === req.org.id && l.type === 'shortlist').map((l) => l.playerId));
  res.json([...ids].map((id) => playerViewForOrg(findPlayer(id), req.org)).filter(Boolean));
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
    const overdue = db.trials.filter((t) => t.orgId === req.org.id && t.status === 'awaiting_report');
    if (overdue.length > 0) {
      return res.status(409).json({
        error: 'REPORTS_OUTSTANDING',
        message: `You have ${overdue.length} trial(s) awaiting a mandatory performance report. File them before requesting new trials.`,
        trialIds: overdue.map((t) => t.id),
      });
    }
  }

  const minor = !isAdult(p);
  const { proposedDate, venue, notes, altSlots } = req.body || {};
  if (notes && !moderateOrRefuse(res, notes, { kind: 'trial_notes', orgId: req.org.id })) return;
  const request = {
    id: nextId('req'),
    playerId: p.id,
    playerName: p.name,
    orgId: req.org.id,
    orgName: req.org.name,
    orgType: req.org.type,
    orgVerified: !!req.org.verified,
    orgSafeguardingCertified: safeguardingCertified(req.org),
    trustedPartner: req.org.trustedPartner,
    userId: req.orgUser.id,
    scoutName: req.orgUser.name,
    scoutRole: req.orgUser.role || 'Scout',
    type,
    message: message || '',
    // Trial logistics: what the player/guardian is actually agreeing to.
    // altSlots lets the other side pick a date that works (counter-proposal).
    trialDetails: type === 'trial'
      ? { proposedDate: proposedDate || null, altSlots: Array.isArray(altSlots) ? altSlots.slice(0, 2) : [], venue: venue || null, notes: notes || '' }
      : null,
    status: 'pending',
    createdAt: Date.now(),
    // Scout → Parent, never Scout → Child.
    routedTo: minor ? 'guardian' : 'player',
    guardianId: minor ? p.guardianId : null,
    contactChannel: null, // stays null until the player/guardian accepts
  };
  db.requests.push(request);
  ledgerAppend({ type: `${type}_request${minor ? '_to_guardian' : ''}`, playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  if (minor) {
    notify({ kind: 'guardian', id: p.guardianId }, 'request', `${req.org.name} has requested to discuss a ${type === 'trial' ? 'trial' : 'conversation'} for ${p.name}.`, request.id);
    notify({ kind: 'player', id: p.id }, 'request', `${req.org.name} contacted your parent/guardian about a ${type === 'trial' ? 'trial' : 'conversation'}.`, request.id);
  } else {
    notify({ kind: 'player', id: p.id }, 'request', `${req.org.name} sent you a ${type} request.`, request.id);
  }
  broadcast('inbox', { playerId: p.id });
  res.status(201).json({ ok: true, requestId: request.id, status: 'pending', routedTo: request.routedTo });
});

// One-click reporting for org users too (report a player, scout or club).
orgRouter.post('/report', (req, res) => handleReport(req, res, { by: 'org_user', byId: req.orgUser.id, byOrgId: req.org.id }));

orgRouter.get('/reports', (req, res) => {
  res.json(db.reports.filter((r) => r.by === 'org_user' && r.byId === req.orgUser.id).slice().reverse());
});

// Message threads for this org — only exist where a request was accepted.
orgRouter.get('/channels', (req, res) => {
  res.json(db.channels.filter((c) => c.orgId === req.org.id).map((c) => channelViewFor(c, 'org')));
});

orgRouter.post('/channels/:id/messages', (req, res) => {
  const channel = db.channels.find((c) => c.id === req.params.id && c.orgId === req.org.id);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
  if (!moderateOrRefuse(res, text, { kind: 'org_message', channelId: channel.id })) return;
  const att = buildAttachment(channel, req.body, 'org');
  if (!att.ok) return res.status(400).json({ error: att.error });
  // postMessage notifies the counterparty (guardian or adult player).
  const msg = postMessage(channel, { kind: 'org_user', id: req.orgUser.id, name: `${req.orgUser.name} · ${req.orgUser.role || 'Scout'} · ${req.org.name}` }, text.trim(), att.attachment);
  res.status(201).json(msg);
});

orgRouter.post('/channels/:id/read', (req, res) => {
  const channel = db.channels.find((c) => c.id === req.params.id && c.orgId === req.org.id);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  channel.readBy.org = Date.now();
  broadcast('messages', { channelId: channel.id });
  res.json({ readBy: channel.readBy });
});

orgRouter.post('/channels/:id/typing', (req, res) => {
  const channel = db.channels.find((c) => c.id === req.params.id && c.orgId === req.org.id);
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
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
  const deck = [];
  for (const p of db.players) {
    const view = playerViewForOrg(p, req.org);
    if (!view) continue;
    for (const m of p.media) {
      if (!m.url) continue;
      deck.push({
        media: { id: m.id, title: m.title, url: m.url, views: m.views ?? 0, verifiedClip: m.verifiedClip, tags: m.tags ?? {} },
        player: {
          id: view.id, name: view.name, position: view.position, age: view.age,
          trustScore: view.trustScore, academyPlus: view.academyPlus, guardianManaged: !!view.guardianManaged,
        },
      });
    }
  }
  deck.sort((a, b) => (b.media.verifiedClip ? 1 : 0) - (a.media.verifiedClip ? 1 : 0) || b.media.views - a.media.views);
  res.json(deck);
});

// Per-clip view tracking — honest scouting signal back to the player.
orgRouter.post('/players/:pid/media/:mid/view', (req, res) => {
  const p = findPlayer(req.params.pid);
  if (!p || !visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const m = p.media.find((x) => x.id === req.params.mid);
  if (!m) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
  m.views = (m.views ?? 0) + 1;
  broadcast('players', { playerId: p.id });
  res.json({ views: m.views });
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
  m.tags ??= {};
  for (const t of tags) m.tags[t] = (m.tags[t] ?? 0) + 1;
  ledgerAppend({ type: 'clip_tagged', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  broadcast('players', { playerId: p.id });
  res.json({ tags: m.tags });
});

orgRouter.get('/tags', (_req, res) => res.json(SCOUT_TAGS));

// The club home feed: what changed since you last looked.
orgRouter.get('/feed', (req, res) => {
  const FOURTEEN_DAYS = Date.now() - 14 * 24 * 3600 * 1000;
  const items = [];
  const shortlisted = new Set(db.ledger.filter((l) => l.orgId === req.org.id && (l.type === 'shortlist' || l.type === 'save')).map((l) => l.playerId));
  for (const p of db.players) {
    const view = playerViewForOrg(p, req.org);
    if (!view) continue;
    if (p.createdAt && p.createdAt >= FOURTEEN_DAYS) {
      items.push({ type: 'new_player', ts: p.createdAt, playerId: p.id, playerName: p.name, position: p.position, age: view.age, guardianManaged: !!view.guardianManaged });
    }
    for (const m of p.media) {
      const uploadedTs = new Date(m.uploadedAt).getTime();
      if (uploadedTs >= FOURTEEN_DAYS) {
        items.push({
          type: shortlisted.has(p.id) ? 'shortlist_new_clip' : 'new_clip',
          ts: uploadedTs, playerId: p.id, playerName: p.name,
          mediaId: m.id, title: m.title, hasVideo: !!m.url, verifiedClip: !!m.verifiedClip,
        });
      }
    }
  }
  for (const t of db.trials.filter((x) => x.orgId === req.org.id && x.status === 'awaiting_report')) {
    items.push({ type: 'report_due', ts: t.reportDueAt ?? Date.now(), playerId: t.playerId, playerName: t.playerName, trialId: t.id, dueAt: t.reportDueAt });
    // one-shot reminder when the mandatory report is due within 48h
    if (!t.reminderSent && t.reportDueAt && t.reportDueAt - Date.now() < 48 * 3600 * 1000) {
      t.reminderSent = true;
      const request = db.requests.find((r) => r.id === t.requestId);
      if (request?.userId) notify({ kind: 'org_user', id: request.userId }, 'report_due', `Mandatory trial report for ${t.playerName} is due ${new Date(t.reportDueAt).toLocaleDateString()}.`, t.id);
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  res.json(items.slice(0, 40));
});

// --------------------------------------------------------- saved searches
// "Tell me when a left-footed U16 winger joins" — the club feed made personal.
function matchesSearch(view, f) {
  if (f.q) {
    const n = String(f.q).toLowerCase();
    if (!view.name.toLowerCase().includes(n) && !(view.city || '').toLowerCase().includes(n) && !(view.country || '').toLowerCase().includes(n)) return false;
  }
  if (f.position && view.position !== f.position) return false;
  if (f.availability && view.availability !== f.availability) return false;
  if (f.academyPlus && !view.academyPlus) return false;
  if (f.country && view.country !== f.country) return false;
  if (f.foot && view.foot !== f.foot) return false;
  if (f.ageGroup === 'u16' && view.age >= 16) return false;
  if (f.ageGroup === 'u18' && view.age >= 18) return false;
  if (f.ageGroup === '18-21' && (view.age < 18 || view.age > 21)) return false;
  if (f.ageGroup === 'senior' && view.age < 22) return false;
  return true;
}

// Called whenever a player joins: alert every saved search that matches.
function checkSavedSearches(player) {
  for (const ss of db.savedSearches) {
    const org = db.orgs.find((o) => o.id === ss.orgId);
    if (!org) continue;
    const view = playerViewForOrg(player, org);
    if (view && matchesSearch(view, ss.filters ?? {})) {
      notify({ kind: 'org_user', id: ss.userId }, 'saved_search', `New match for your saved search “${ss.name}”: ${player.name} (${player.position ?? '—'}) just joined.`, player.id);
    }
  }
}

orgRouter.get('/searches', (req, res) => {
  res.json(db.savedSearches.filter((s) => s.orgId === req.org.id));
});

orgRouter.post('/searches', (req, res) => {
  const { name, filters } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'NAME_REQUIRED' });
  const ss = { id: nextId('ss'), orgId: req.org.id, userId: req.orgUser.id, scoutName: req.orgUser.name, name: name.trim(), filters: filters ?? {}, createdAt: Date.now() };
  db.savedSearches.push(ss);
  res.status(201).json(ss);
});

orgRouter.delete('/searches/:id', (req, res) => {
  const idx = db.savedSearches.findIndex((s) => s.id === req.params.id && s.orgId === req.org.id);
  if (idx === -1) return res.status(404).json({ error: 'SEARCH_NOT_FOUND' });
  db.savedSearches.splice(idx, 1);
  persist();
  res.json({ ok: true });
});

// Calendar export for an accepted trial.
orgRouter.get('/trials/:id/ics', (req, res) => {
  const t = db.trials.find((x) => x.id === req.params.id && x.orgId === req.org.id);
  if (!t) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
  const start = t.proposedDate ? t.proposedDate.replace(/-/g, '') : new Date(t.acceptedAt).toISOString().slice(0, 10).replace(/-/g, '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ScoutBox//Trials//EN', 'BEGIN:VEVENT',
    `UID:${t.id}@scoutbox`, `DTSTART;VALUE=DATE:${start}`,
    `SUMMARY:ScoutBox trial — ${t.playerName}`,
    `DESCRIPTION:${(t.notes || 'Assessment trial').replace(/\n/g, ' ')}. Mandatory performance report due ${new Date(t.reportDueAt ?? Date.now()).toISOString().slice(0, 10)}.`,
    t.venue ? `LOCATION:${t.venue}` : null,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  res.set('Content-Type', 'text/calendar').send(ics);
});

// Fixture-graph scouting: verified attendances form a map of real fixtures.
orgRouter.get('/fixtures', (req, res) => {
  const groups = {};
  for (const p of db.players) {
    if (!playerViewForOrg(p, req.org)) continue;
    for (const a of p.attendance) {
      const key = `${a.fixture}|${a.date}`;
      groups[key] ??= { fixture: a.fixture, venue: a.venue, date: a.date, players: [] };
      groups[key].players.push({ id: p.id, name: p.name, position: p.position, age: ageOn(p.dob), trustScore: computeTrustScore(p) });
    }
  }
  res.json(Object.values(groups).sort((a, b) => (a.date < b.date ? 1 : -1)));
});

orgRouter.get('/requests', (req, res) => {
  res.json(db.requests.filter((r) => r.orgId === req.org.id));
});

orgRouter.get('/trials', (req, res) => {
  res.json(db.trials.filter((t) => t.orgId === req.org.id));
});

// Trial Performance Reports — mandatory, complete or rejected.
orgRouter.post('/trials/:trialId/report', (req, res) => {
  const trial = db.trials.find((t) => t.id === req.params.trialId && t.orgId === req.org.id);
  if (!trial) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
  if (trial.status === 'reported') return res.status(409).json({ error: 'ALREADY_REPORTED' });

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
  trial.status = 'reported';
  trial.report = report;

  // Filed reports sync to the player profile and raise Trust Score
  // (institutional corroboration).
  const p = findPlayer(trial.playerId);
  p.trialReports.push(report);
  ledgerAppend({ type: 'trial_report', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  notify({ kind: 'player', id: p.id }, 'trial_report', `${req.org.name} filed your trial report${report.strengthNote ? ' — with development feedback' : ''}. It's on your profile.`, report.id);
  if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'trial_report', `${req.org.name} filed the trial report for ${p.name}.`, report.id);
  broadcast('players', { playerId: p.id });
  res.status(201).json({ ok: true, report, playerTrustScore: computeTrustScore(p) });
});

// The revenue event, completed: recording a signing updates the player's
// timeline + contract, freezes the attribution evidence from the Proof Pack,
// and notifies the player (and guardian for minors).
orgRouter.post('/players/:id/signing', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
  if (isBlocked(p.id, req.org.id)) return res.status(403).json({ error: 'BLOCKED' });
  const events = db.ledger.filter((l) => l.playerId === p.id && l.orgId === req.org.id);
  const first = events[0] ?? null;
  const windowMonths = db.plans[req.org.plan]?.attributionWindowMonths ?? 18;
  const windowEnds = first ? first.ts + windowMonths * 30.44 * 24 * 3600 * 1000 : null;
  const row = ledgerAppend({ type: 'signing', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  const signing = {
    id: nextId('sign'),
    playerId: p.id,
    playerName: p.name,
    orgId: req.org.id,
    orgName: req.org.name,
    userId: req.orgUser.id,
    scoutName: req.orgUser.name,
    ts: row.ts,
    firstQualifyingInteraction: first,
    attributionWindowMonths: windowMonths,
    insideAttributionWindow: first ? row.ts <= windowEnds : false,
  };
  db.signings.push(signing);
  // The revenue event: a signing inside the attribution window issues the
  // success-fee invoice through the billing adapter (Stripe when live).
  if (signing.insideAttributionWindow) void billing.invoiceForSigning(signing, req.org);
  // A signing moves the player's level: grassroots signings make semi-pros,
  // academy/pro signings make pros — who then leave the Grassroots platform.
  const levelBefore = p.level ?? 'amateur';
  p.level = playerLevelAfterSigning(req.org.level);
  if (levelBefore === 'amateur' && p.level === 'semi_pro') {
    // The level-up moment: a life event, celebrated and recorded.
    p.timeline.push({ year: String(new Date().getFullYear()), event: `Levelled up: amateur → semi-pro with ${req.org.name}` });
    notify({ kind: 'player', id: p.id }, 'level_up', `⬆️ You're semi-pro. ${req.org.name} signed you — one step up the ladder, recorded forever on your pathway.`, p.id);
    if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'level_up', `${p.name} levelled up: amateur → semi-pro with ${req.org.name}.`, p.id);
  } else if (levelBefore !== 'pro' && p.level === 'pro') {
    p.timeline.push({ year: String(new Date().getFullYear()), event: `Levelled up: ${levelBefore.replace('_', '-')} → pro with ${req.org.name}` });
    notify({ kind: 'player', id: p.id }, 'level_up', `⬆️ Academy/pro level reached with ${req.org.name}. Your grassroots journey got you here.`, p.id);
    if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'level_up', `${p.name} reached academy/pro level with ${req.org.name}.`, p.id);
  }
  refreshJourneyBadges(p);
  // A grassroots signing puts the player straight onto the club's squad list,
  // so match-day logging and gap analysis start from the real roster.
  if (req.org.level === 'grassroots') {
    req.org.squad ??= [];
    if (!req.org.squad.some((e) => e.playerId === p.id)) {
      req.org.squad.push({ id: nextId('sq'), playerId: p.id, name: p.name, position: p.position ?? '', source: 'signing', addedAt: row.ts });
    }
  }
  p.contractStatus = 'under_contract';
  p.availability = 'not_seeking';
  p.timeline.push({ year: String(new Date().getFullYear()), event: `Signed by ${req.org.name} — discovered on ScoutBox` });
  notify({ kind: 'player', id: p.id }, 'signing', `🎉 ${req.org.name} recorded your signing. Congratulations — it's on your timeline.`, signing.id);
  if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'signing', `${req.org.name} recorded ${p.name}'s signing.`, signing.id);
  broadcast('players', { playerId: p.id });
  res.status(201).json({ ok: true, signing });
});

orgRouter.get('/signings', (req, res) => {
  res.json(db.signings.filter((s) => s.orgId === req.org.id).slice().reverse());
});

orgRouter.get('/invoices', (req, res) => {
  res.json(db.invoices.filter((i) => i.orgId === req.org.id).slice().reverse());
});

// ------------------------------------------- open trial days (grassroots)
function grassrootsOrgOnly(req, res) {
  if (req.org.level !== 'grassroots') {
    res.status(403).json({ error: 'GRASSROOTS_ORGS_ONLY', message: 'Open days are a ScoutBox Grassroots feature.' });
    return true;
  }
  return false;
}

orgRouter.post('/open-trials', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  // The no-ghosting rule: nobody — least of all a kid at their first session —
  // leaves an open day without an answer. Unresolved past registrants block
  // the next posting, the same way unfiled trial reports block new trials.
  const today = new Date().toISOString().slice(0, 10);
  const unresolved = db.openTrials
    .filter((t) => t.orgId === req.org.id && t.date < today)
    .flatMap((t) => (t.registrations ?? []).filter((r) => !r.outcome));
  if (unresolved.length > 0) {
    return res.status(409).json({
      error: 'OUTCOMES_OUTSTANDING',
      message: `${unresolved.length} player(s) from your past open day(s) are still waiting for an answer. Resolve them (invite or a kind no) before posting the next one.`,
    });
  }
  const { title, date, venue, ageGroup, positions, notes } = req.body || {};
  if (!title || !date || !venue) return res.status(400).json({ error: 'TITLE_DATE_VENUE_REQUIRED' });
  if (notes && !moderateOrRefuse(res, notes, { kind: 'open_trial_notes', orgId: req.org.id })) return;
  const trial = {
    id: nextId('open'), orgId: req.org.id, orgName: req.org.name,
    title: String(title).trim(), date: String(date), venue: String(venue).trim(),
    ageGroup: ageGroup || 'open', positions: Array.isArray(positions) ? positions : [],
    notes: notes || '', createdByUserId: req.orgUser.id, createdAt: Date.now(), registrations: [],
  };
  db.openTrials.push(trial);
  ledgerAppend({ type: 'open_trial_posted', playerId: null, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  persist();
  broadcast('openTrials');
  res.status(201).json({ openTrial: trial });
});

orgRouter.get('/open-trials', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  // Registration lists respect visibility: a club that cannot see a minor
  // never received their registration in the first place.
  res.json(db.openTrials.filter((t) => t.orgId === req.org.id).map((t) => ({
    ...t,
    registrations: (t.registrations ?? []).map((r) => {
      const p = findPlayer(r.playerId);
      const view = p ? playerViewForOrg(p, req.org) : null;
      return { ...r, age: view?.age ?? null, position: view?.position ?? null, trustScore: view?.trustScore ?? null, guardianManaged: !!view?.guardianManaged };
    }),
  })).reverse());
});

orgRouter.delete('/open-trials/:id', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const before = db.openTrials.length;
  db.openTrials = db.openTrials.filter((t) => !(t.id === req.params.id && t.orgId === req.org.id));
  if (db.openTrials.length === before) return res.status(404).json({ error: 'OPEN_TRIAL_NOT_FOUND' });
  persist();
  broadcast('openTrials');
  res.json({ deleted: true });
});

// What the club is looking for — powers the players' opportunity radar.
orgRouter.post('/looking-for', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const positions = Array.isArray(req.body?.positions) ? req.body.positions.slice(0, 5) : [];
  req.org.lookingFor = positions;
  persist();
  broadcast('orgs');
  res.json({ lookingFor: req.org.lookingFor });
});

// Every open-day registrant gets an answer: an invitation (which creates a
// real, properly-routed trial request) or a kind no.
orgRouter.post('/open-trials/:id/registrations/:regId/outcome', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const trial = db.openTrials.find((t) => t.id === req.params.id && t.orgId === req.org.id);
  const reg = trial?.registrations?.find((r) => r.id === req.params.regId);
  if (!trial || !reg) return res.status(404).json({ error: 'REGISTRATION_NOT_FOUND' });
  if (reg.outcome) return res.status(409).json({ error: 'ALREADY_RESOLVED' });
  const { outcome, note } = req.body || {};
  if (!['invite_trial', 'declined'].includes(outcome)) return res.status(400).json({ error: 'OUTCOME_INVALID' });
  if (note && !moderateOrRefuse(res, note, { kind: 'open_day_outcome', orgId: req.org.id })) return;
  const p = findPlayer(reg.playerId);
  reg.outcome = outcome;
  reg.outcomeNote = note ? String(note).trim().slice(0, 200) : null;
  reg.outcomeAt = Date.now();
  if (p && visibleToOrg(p, req.org)) {
    if (outcome === 'invite_trial') {
      const minor = !isAdult(p);
      const request = {
        id: nextId('req'), playerId: p.id, playerName: p.name,
        orgId: req.org.id, orgName: req.org.name, orgType: req.org.type,
        orgVerified: !!req.org.verified, orgSafeguardingCertified: safeguardingCertified(req.org),
        trustedPartner: req.org.trustedPartner, userId: req.orgUser.id,
        scoutName: req.orgUser.name, scoutRole: req.orgUser.role || 'Manager',
        type: 'trial',
        message: reg.outcomeNote || `We liked what we saw at "${trial.title}" — come for a proper trial.`,
        trialDetails: { proposedDate: null, altSlots: [], venue: trial.venue, notes: `Follow-up from open day "${trial.title}".` },
        status: 'pending', createdAt: Date.now(),
        routedTo: minor ? 'guardian' : 'player', guardianId: minor ? p.guardianId : null,
        contactChannel: null,
      };
      db.requests.push(request);
      ledgerAppend({ type: `trial_request${minor ? '_to_guardian' : ''}`, playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
      if (minor) {
        notify({ kind: 'guardian', id: p.guardianId }, 'open_trial', `Good news: ${req.org.name} would like to invite ${p.name} for a trial after the open day.`, request.id);
        notify({ kind: 'player', id: p.id }, 'open_trial', `${req.org.name} liked what they saw at the open day — they've contacted your parent/guardian about a trial.`, request.id);
      } else {
        notify({ kind: 'player', id: p.id }, 'open_trial', `⚽ ${req.org.name} liked what they saw at "${trial.title}" — trial invitation in your inbox.`, request.id);
      }
    } else {
      const kindNo = reg.outcomeNote || 'Thanks for coming — not this time, but keep playing and keep logging your football.';
      if (!isAdult(p) && p.guardianId) {
        notify({ kind: 'guardian', id: p.guardianId }, 'open_trial', `${req.org.name} on ${p.name}'s open day: ${kindNo}`, trial.id);
      }
      notify({ kind: 'player', id: p.id }, 'open_trial', `${req.org.name}: ${kindNo}`, trial.id);
    }
  }
  persist();
  broadcast('openTrials');
  res.json({ registration: reg });
});

// ----------------------------------------------- squad + match-day logging
// The club's own players in one place — and one Saturday action that gives
// the whole squad verified, coach-signed attendance.
const POSITION_GROUPS = { GK: ['GK'], DEF: ['CB', 'RB', 'LB', 'RWB', 'LWB'], MID: ['CDM', 'CM', 'CAM'], ATT: ['ST', 'CF', 'RW', 'LW'] };

function squadView(org) {
  const entries = (org.squad ?? []).map((e) => {
    const p = e.playerId ? findPlayer(e.playerId) : null;
    return { ...e, onPlatform: !!p, trustScore: p ? computeTrustScore(p) : null };
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
  if (!name || !name.trim()) return res.status(400).json({ error: 'NAME_REQUIRED' });
  if (playerId) {
    const p = findPlayer(playerId);
    if (!p || !visibleToOrg(p, req.org)) return res.status(403).json({ error: 'PLAYER_NOT_VISIBLE' });
    if ((req.org.squad ?? []).some((e) => e.playerId === playerId)) return res.status(409).json({ error: 'ALREADY_ON_SQUAD' });
  }
  req.org.squad ??= [];
  req.org.squad.push({ id: nextId('sq'), name: String(name).trim(), position: position || null, playerId: playerId || null, source: 'manual', addedAt: Date.now() });
  persist();
  res.status(201).json(squadView(req.org));
});

// Release with a reference: the worst moment in grassroots football, done
// properly — availability restored, and optionally a club-authored reference
// published on the way out (club identity is already authenticated).
orgRouter.post('/squad/:entryId/release', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const entry = (req.org.squad ?? []).find((e) => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: 'SQUAD_ENTRY_NOT_FOUND' });
  const { referenceText } = req.body || {};
  if (referenceText && !moderateOrRefuse(res, referenceText, { kind: 'release_reference', orgId: req.org.id })) return;
  req.org.squad = req.org.squad.filter((e) => e !== entry);
  const p = entry.playerId ? findPlayer(entry.playerId) : null;
  if (p) {
    p.availability = 'available_now';
    p.contractStatus = 'free_agent';
    if (referenceText) {
      db.vouches.push({
        id: nextId('vch'), playerId: p.id, playerName: p.name,
        coachName: req.orgUser.name, coachEmail: null, role: `${req.orgUser.role || 'Manager'}, ${req.org.name}`,
        status: 'published', code: null, text: String(referenceText).trim().slice(0, 400),
        seasons: null, ts: Date.now(), publishedAt: Date.now(),
      });
    }
    ledgerAppend({ type: 'released_by_club', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    notify({ kind: 'player', id: p.id }, 'released',
      `${req.org.name} has released you${referenceText ? ' — with a reference now on your profile' : ''}. You're marked available to every local club; the First Team Seeker flag is yours to switch on.`, p.id);
    if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'released', `${req.org.name} released ${p.name}${referenceText ? ' with a reference' : ''}. Their profile is marked available again.`, p.id);
    broadcast('players', { playerId: p.id });
  }
  persist();
  res.json(squadView(req.org));
});

orgRouter.post('/matchday', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const { fixture, venue, date, result, playerIds } = req.body || {};
  if (!fixture || !date) return res.status(400).json({ error: 'FIXTURE_AND_DATE_REQUIRED' });
  const ids = Array.isArray(playerIds) ? playerIds : [];
  const onSquad = new Set((req.org.squad ?? []).map((e) => e.playerId).filter(Boolean));
  const credited = [];
  for (const pid of ids) {
    if (!onSquad.has(pid)) continue; // only your own rostered players
    const p = findPlayer(pid);
    if (!p || !visibleToOrg(p, req.org)) continue;
    p.attendance.push({
      id: nextId('att'), fixture: String(fixture), venue: String(venue || req.org.location?.city || ''),
      date: String(date), gps: req.org.location ? { lat: req.org.location.lat, lng: req.org.location.lng } : null,
      verified: true, corroboratedBy: req.org.name, // coach counter-signature
    });
    recordActivity(p);
    notify({ kind: 'player', id: p.id }, 'matchday', `📍 ${req.org.name} logged your appearance in "${fixture}" — verified, coach-signed attendance on your profile.`, p.id);
    credited.push(p.id);
    broadcast('players', { playerId: p.id });
  }
  db.matchdays.push({
    id: nextId('md'), orgId: req.org.id, fixture: String(fixture), venue: String(venue || ''),
    date: String(date), result: result ? String(result).slice(0, 20) : null,
    playerIds: credited, loggedByUserId: req.orgUser.id, ts: Date.now(),
  });
  ledgerAppend({ type: 'matchday_logged', playerId: null, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  persist();
  res.status(201).json({ credited: credited.length, matchdays: db.matchdays.filter((m) => m.orgId === req.org.id).length });
});

orgRouter.get('/matchdays', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  res.json(db.matchdays.filter((m) => m.orgId === req.org.id).slice().reverse());
});

// --------------------------------------------------- pathway club record
// Grassroots reputation currency: not resale multiples — players developed.
function pathwayRecord(org) {
  const involvedIds = new Set([
    ...db.signings.filter((sg) => sg.orgId === org.id).map((sg) => sg.playerId),
    ...(org.squad ?? []).map((e) => e.playerId).filter(Boolean),
    ...db.openTrials.filter((t) => t.orgId === org.id).flatMap((t) => (t.registrations ?? []).map((r) => r.playerId)),
  ]);
  const firstInvolvement = (pid) => Math.min(
    ...db.signings.filter((sg) => sg.orgId === org.id && sg.playerId === pid).map((sg) => sg.ts),
    ...db.openTrials.filter((t) => t.orgId === org.id).flatMap((t) => (t.registrations ?? []).filter((r) => r.playerId === pid).map((r) => r.ts)),
  );
  const progressed = [...involvedIds].filter((pid) => {
    const upward = db.signings.find((sg) => sg.playerId === pid && sg.orgId !== org.id && (db.orgs.find((o) => o.id === sg.orgId)?.level ?? '') !== 'grassroots');
    return upward && upward.ts > firstInvolvement(pid);
  });
  return { progressed: progressed.length, pathwayClub: progressed.length >= 1 };
}

orgRouter.get('/pathway-record', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  res.json({
    ...pathwayRecord(req.org),
    openDaysRun: db.openTrials.filter((t) => t.orgId === req.org.id).length,
    matchdaysLogged: db.matchdays.filter((m) => m.orgId === req.org.id).length,
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
  req.org.federationCheck = {
    federation: String(federation).trim(), registrationId: String(registrationId).trim(),
    contactEmail: contactEmail ? String(contactEmail).trim() : null,
    status: 'pending', ts: Date.now(),
  };
  persist();
  broadcast('orgs');
  res.status(201).json({
    submitted: true,
    note: 'Trust & Safety cross-checks the registration with your federation. Verification (and with the safeguarding contract, U18 visibility) follows their approval.',
  });
});

// ---------------------------------------------------- friendlies board
// Club-to-club, same 50km radius: trial matches are how grassroots scouting
// actually happens — and a reason to open the app between transfer windows.
orgRouter.post('/friendlies', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const { ageGroup, date, venue, notes } = req.body || {};
  if (!date) return res.status(400).json({ error: 'DATE_REQUIRED' });
  if (notes && !moderateOrRefuse(res, notes, { kind: 'friendly_notes', orgId: req.org.id })) return;
  const friendly = {
    id: nextId('fr'), orgId: req.org.id, orgName: req.org.name, postedByUserId: req.orgUser.id,
    ageGroup: ageGroup || 'open', date: String(date), venue: venue ? String(venue).trim() : (req.org.location?.city ?? ''),
    notes: notes || '', status: 'open', responses: [], createdAt: Date.now(),
  };
  db.friendlies.push(friendly);
  persist();
  broadcast('friendlies');
  res.status(201).json({ friendly });
});

orgRouter.get('/friendlies', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const nearby = db.friendlies.filter((f) => {
    if (f.orgId === req.org.id) return true;
    const other = db.orgs.find((o) => o.id === f.orgId);
    return other?.location && req.org.location && haversineKm(other.location, req.org.location) <= GRASSROOTS_RADIUS_KM;
  }).map((f) => {
    const other = db.orgs.find((o) => o.id === f.orgId);
    return {
      ...f,
      mine: f.orgId === req.org.id,
      distanceKm: f.orgId === req.org.id || !other?.location || !req.org.location
        ? 0 : Math.round(haversineKm(other.location, req.org.location) * 10) / 10,
      // responder details only for the poster
      responses: f.orgId === req.org.id ? f.responses : f.responses.map(({ message, ...r }) => ({ ...r, message: '' })),
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  res.json(nearby);
});

orgRouter.post('/friendlies/:id/respond', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const friendly = db.friendlies.find((f) => f.id === req.params.id);
  if (!friendly) return res.status(404).json({ error: 'FRIENDLY_NOT_FOUND' });
  if (friendly.orgId === req.org.id) return res.status(400).json({ error: 'OWN_POST' });
  const { message } = req.body || {};
  if (message && !moderateOrRefuse(res, message, { kind: 'friendly_response', orgId: req.org.id })) return;
  if (friendly.responses.some((r) => r.orgId === req.org.id)) return res.status(409).json({ error: 'ALREADY_RESPONDED' });
  friendly.responses.push({ orgId: req.org.id, orgName: req.org.name, message: message ? String(message).trim().slice(0, 200) : '', respondedByUserId: req.orgUser.id, ts: Date.now() });
  if (friendly.postedByUserId) notify({ kind: 'org_user', id: friendly.postedByUserId }, 'friendly', `${req.org.name} is up for your friendly on ${friendly.date}.`, friendly.id);
  persist();
  broadcast('friendlies');
  res.status(201).json({ responded: true });
});

// ------------------------------------------------------ recruitment funnel
// The club's whole pipeline computed from the ledger — every stage is a real
// recorded event, so the numbers are the numbers.
orgRouter.get('/funnel', (req, res) => {
  const mine = db.ledger.filter((l) => l.orgId === req.org.id);
  const count = (type) => mine.filter((l) => l.type.startsWith(type)).length;
  const requests = db.requests.filter((r) => r.orgId === req.org.id);
  res.json({
    stages: [
      { key: 'views', label: 'Profile views', count: count('view') },
      { key: 'saves', label: 'Saves', count: count('save') },
      { key: 'shortlists', label: 'Shortlists', count: count('shortlist') },
      { key: 'requests', label: 'Requests sent', count: requests.length },
      { key: 'accepted', label: 'Requests accepted', count: requests.filter((r) => r.status === 'accepted').length },
      { key: 'trials', label: 'Trials booked', count: db.trials.filter((t) => t.orgId === req.org.id).length },
      { key: 'reports', label: 'Reports filed', count: db.trials.filter((t) => t.orgId === req.org.id && t.status === 'reported').length },
      { key: 'signings', label: 'Signings', count: db.signings.filter((s) => s.orgId === req.org.id).length },
    ],
    byScout: Object.values(mine.reduce((acc, l) => {
      if (!l.scoutName) return acc;
      acc[l.scoutName] ??= { scoutName: l.scoutName, events: 0 };
      acc[l.scoutName].events += 1;
      return acc;
    }, {})).sort((a, b) => b.events - a.events).slice(0, 8),
  });
});

// -------------------------------------------- club email-domain verification
// Verification stops being an attestation: the club proves control of a
// company mailbox. Free-mail domains are refused outright.
const FREE_MAIL = /@(gmail|googlemail|hotmail|outlook|yahoo|icloud|aol|proton|protonmail|gmx|live|msn)\./i;

orgRouter.post('/verification/email', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  if (FREE_MAIL.test(email)) {
    return res.status(422).json({
      error: 'COMPANY_EMAIL_REQUIRED',
      message: 'Free email providers don\'t prove domain control. No club domain? Use federation verification instead — your federation registration is checked by Trust & Safety.',
    });
  }
  const code = randomCode(6);
  db.emailChallenges = db.emailChallenges.filter((c) => c.orgId !== req.org.id);
  db.emailChallenges.push({ orgId: req.org.id, email, code, expiresAt: Date.now() + 30 * 60 * 1000 });
  await mailer.send({
    to: email,
    subject: `Verify ${req.org.name} on ScoutBox`,
    text: `Your ScoutBox club verification code is ${code}.\n\nEntering it confirms ${req.org.name} controls this company mailbox — one of the safeguarding requirements before a club can see under-18 players.`,
  });
  persist();
  res.status(201).json({ sent: true, note: 'Enter the code from the mailbox to confirm domain control.' });
});

orgRouter.post('/verification/email/confirm', (req, res) => {
  const { code } = req.body || {};
  const challenge = db.emailChallenges.find((c) => c.orgId === req.org.id);
  if (!challenge || challenge.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'CHALLENGE_NOT_FOUND', message: 'Request a fresh code — none is active for this club.' });
  }
  if (String(code ?? '').trim().toUpperCase() !== challenge.code) {
    return res.status(400).json({ error: 'CODE_INVALID', message: 'That code doesn\'t match — check the email.' });
  }
  db.emailChallenges = db.emailChallenges.filter((c) => c !== challenge);
  req.org.emailDomain = challenge.email.split('@')[1];
  req.org.emailDomainVerified = true;
  persist();
  broadcast('orgs');
  res.json({ emailDomainVerified: true, emailDomain: req.org.emailDomain });
});

// ------------------------------------------------- ledger, proof, plan etc
orgRouter.get('/ledger', (req, res) => {
  res.json(db.ledger.filter((l) => l.orgId === req.org.id).slice().reverse());
});

// Proof Pack: attribution evidence for this org on this player.
orgRouter.get('/players/:id/proofpack', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
  const events = db.ledger.filter((l) => l.playerId === p.id && l.orgId === req.org.id);
  const first = events[0] || null;
  const windowMonths = db.plans[req.org.plan]?.attributionWindowMonths ?? 18;
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
  const plan = db.plans[req.org.plan];
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
  for (const l of db.ledger) {
    const key = `${l.scoutName}|${l.orgName}`;
    live[key] ??= { scoutName: l.scoutName, orgName: l.orgName, views: 0, contacts: 0, trials: 0, signings: 0, seeded: false };
    if (l.type === 'view') live[key].views++;
    if (l.type === 'contact_request') live[key].contacts++;
    if (l.type === 'trial_request' || l.type === 'trial_report') live[key].trials++;
    if (l.type === 'signing') live[key].signings++;
  }
  res.json({ seeded: db.reputationSeed, live: Object.values(live) });
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
    vouches: db.vouches.filter((v) => v.playerId === req.player.id).map(({ coachEmail, code, ...v }) => v),
  });
});

// Aging-up transition: the day a guardian-owned player is an adult, ownership
// moves to them — explicit consent, guardian notified, ledger records it.
playerRouter.post('/aging-up/complete', (req, res) => {
  if (!isAdult(req.player)) return res.status(403).json({ error: 'STILL_A_MINOR', message: 'The transition unlocks on your 18th birthday (age of majority in your country).' });
  if (!req.player.guardianId) return res.status(400).json({ error: 'ALREADY_OWNED', message: 'You already own this account.' });
  const guardian = db.guardians.find((g) => g.id === req.player.guardianId);
  if (guardian) {
    guardian.childIds = guardian.childIds.filter((id) => id !== req.player.id);
    notify({ kind: 'guardian', id: guardian.id }, 'aging_up', `${req.player.name} is 18 — their account is now their own. Their history stays intact, and thank you for keeping it safe.`, req.player.id);
  }
  req.player.guardianId = null;
  req.player.timeline.push({ year: String(new Date().getFullYear()), event: 'Turned 18 — took ownership of this ScoutBox account' });
  ledgerAppend({ type: 'account_transitioned', playerId: req.player.id, orgId: null, orgName: 'ScoutBox', userId: null, scoutName: 'system' });
  notify({ kind: 'player', id: req.player.id }, 'aging_up', 'Your account is now fully yours. Availability, medical sharing and club contact are your calls from here.', req.player.id);
  broadcast('players', { playerId: req.player.id });
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
playerRouter.get('/inbox', (req, res) => {
  const rows = db.requests.filter((r) => r.playerId === req.player.id);
  if (req.playerIsMinor) {
    return res.json(
      rows
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
        }))
        .slice()
        .reverse()
    );
  }
  res.json(rows.map(({ orgId, userId, ...visible }) => visible).slice().reverse());
});

playerRouter.post('/requests/:id/respond', (req, res) => {
  if (guardianManagedOnly(req, res)) return; // minors never respond — guardians do
  const request = db.requests.find((r) => r.id === req.params.id && r.playerId === req.player.id && r.routedTo === 'player');
  if (!request) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'ALREADY_RESPONDED' });
  const { accept, chosenSlot } = req.body || {};
  request.status = accept ? 'accepted' : 'declined';
  request.respondedAt = Date.now();

  if (accept) {
    // Only now does a contact channel exist.
    const channel = openChannel(request);
    request.contactChannel = channel.id;
    ledgerAppend({ type: `${request.type}_accepted`, playerId: req.player.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    if (request.type === 'trial') {
      const details = request.trialDetails ?? {};
      const slotOk = chosenSlot && (chosenSlot === details.proposedDate || (details.altSlots ?? []).includes(chosenSlot));
      const trialDate = slotOk ? chosenSlot : details.proposedDate ?? null;
      db.trials.push({
        id: nextId('trial'),
        requestId: request.id,
        playerId: req.player.id,
        playerName: req.player.name,
        orgId: request.orgId,
        orgName: request.orgName,
        scoutName: request.scoutName,
        acceptedAt: Date.now(),
        proposedDate: trialDate,
        venue: details.venue ?? null,
        notes: details.notes ?? '',
        reportDueAt: (trialDate ? new Date(trialDate).getTime() : Date.now()) + 7 * 24 * 3600 * 1000,
        status: 'awaiting_report', // mandatory report gate
      });
    }
    notify({ kind: 'org_user', id: request.userId }, 'accepted', `${req.player.name} accepted your ${request.type} request — thread open.`, request.contactChannel);
  } else {
    ledgerAppend({ type: `${request.type}_declined`, playerId: req.player.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    notify({ kind: 'org_user', id: request.userId }, 'declined', `${req.player.name} declined your ${request.type} request.`, request.id);
  }
  broadcast('requests', { playerId: req.player.id });
  const { orgId, userId, ...visible } = request;
  res.json(visible);
});

// Adult players talk in their own threads; a child never has one.
playerRouter.get('/channels', (req, res) => {
  if (req.playerIsMinor) return res.json([]); // threads live with the guardian
  res.json(db.channels.filter((c) => c.playerId === req.player.id && c.counterparty === 'player').map((c) => channelViewFor(c, 'player')));
});

playerRouter.post('/channels/:id/messages', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  const channel = db.channels.find((c) => c.id === req.params.id && c.playerId === req.player.id && c.counterparty === 'player');
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
  if (!moderateOrRefuse(res, text, { kind: 'player_message', channelId: channel.id })) return;
  const att = buildAttachment(channel, req.body, 'player');
  if (!att.ok) return res.status(400).json({ error: att.error });
  res.status(201).json(postMessage(channel, { kind: 'player', id: req.player.id, name: req.player.name }, text.trim(), att.attachment));
});

playerRouter.post('/channels/:id/read', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  const channel = db.channels.find((c) => c.id === req.params.id && c.playerId === req.player.id && c.counterparty === 'player');
  if (!channel) return res.status(404).json({ error: 'CHANNEL_NOT_FOUND' });
  channel.readBy.counterparty = Date.now();
  broadcast('messages', { channelId: channel.id });
  res.json({ readBy: channel.readBy });
});

playerRouter.post('/channels/:id/typing', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  const channel = db.channels.find((c) => c.id === req.params.id && c.playerId === req.player.id && c.counterparty === 'player');
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
  res.json(db.reports.filter((r) => r.by === 'player' && r.byId === req.player.id).slice().reverse());
});

// Academy+ is opt-in only and player-controlled (guardian-managed for minors).
playerRouter.post('/academyplus', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  req.player.academyPlus = !!req.body?.enabled;
  if (req.player.academyPlus && !req.player.badges.includes('Fresh Start')) req.player.badges.push('Fresh Start');
  if (!req.player.academyPlus) req.player.badges = req.player.badges.filter((b) => b !== 'Fresh Start');
  broadcast('players', { playerId: req.player.id });
  res.json({ academyPlus: req.player.academyPlus, badges: req.player.badges });
});

playerRouter.post('/badges', (req, res) => {
  const { badges } = req.body || {};
  if (!Array.isArray(badges)) return res.status(400).json({ error: 'BADGES_MUST_BE_ARRAY' });
  req.player.badges = badges.slice(0, 6).map(String);
  broadcast('players', { playerId: req.player.id });
  res.json({ badges: req.player.badges });
});

// Media upload. `dataUrl` carries the actual video (prototype in-memory
// store, ~12MB cap; production = object storage behind the same endpoint).
playerRouter.post('/media', (req, res) => {
  const { title, kind = 'video', dataUrl, attendanceId } = req.body || {};
  if (!title) return res.status(400).json({ error: 'TITLE_REQUIRED' });
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
  req.player.media.push(item);
  recordActivity(req.player);
  broadcast('players', { playerId: req.player.id });
  res.status(201).json({ media: item, trustScore: computeTrustScore(req.player) });
});

// Medical data is player-controlled per data-protection law.
// For a minor, that control sits with the guardian.
playerRouter.post('/medical/share', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  req.player.medical.shared = !!req.body?.shared;
  broadcast('players', { playerId: req.player.id });
  res.json({ shared: req.player.medical.shared });
});

playerRouter.post('/medical/records', (req, res) => {
  const { type, title, date, layoffWeeks, cleared, conditionStatus } = req.body || {};
  if (conditionStatus) req.player.medical.conditionStatus = conditionStatus;
  if (title) {
    req.player.medical.records.push({ id: nextId('md'), type: type || 'note', title, date: date || new Date().toISOString().slice(0, 10), layoffWeeks: layoffWeeks ?? null, cleared: cleared ?? null });
  }
  broadcast('players', { playerId: req.player.id });
  res.status(201).json(req.player.medical);
});

// Location powers the Grassroots 50km radius. Coordinates never appear in
// any org view — only the computed distance does.
playerRouter.post('/location', (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'BAD_COORDINATES' });
  }
  req.player.location = { lat, lng };
  persist();
  broadcast('players', { playerId: req.player.id });
  res.json({ ok: true });
});

playerRouter.post('/availability', (req, res) => {
  if (guardianManagedOnly(req, res)) return;
  const { availability, contractStatus } = req.body || {};
  const AV = ['available_now', 'end_of_season', 'loan_open', 'overseas_open', 'not_seeking'];
  const CS = ['under_contract', 'expiring_summer', 'scholarship_ending', 'release_approaching', 'free_agent', 'unknown'];
  if (availability && !AV.includes(availability)) return res.status(400).json({ error: 'BAD_AVAILABILITY', allowed: AV });
  if (contractStatus && !CS.includes(contractStatus)) return res.status(400).json({ error: 'BAD_CONTRACT_STATUS', allowed: CS });
  if (availability) req.player.availability = availability;
  if (contractStatus) req.player.contractStatus = contractStatus;
  broadcast('players', { playerId: req.player.id });
  res.json({ availability: req.player.availability, contractStatus: req.player.contractStatus });
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
  const item = { id: nextId('att'), fixture, venue, date, gps, deviceConfirmed: true, verified: true };
  req.player.attendance.push(item);
  recordActivity(req.player);
  ledgerAppend({ type: 'attendance_verified', playerId: req.player.id, orgId: null, orgName: 'ScoutBox', userId: null, scoutName: 'system' });
  broadcast('players', { playerId: req.player.id });
  res.status(201).json({ attendance: item, trustScore: computeTrustScore(req.player) });
});

playerRouter.post('/timeline', (req, res) => {
  const { year, event } = req.body || {};
  if (!year || !event) return res.status(400).json({ error: 'YEAR_AND_EVENT_REQUIRED' });
  if (!moderateOrRefuse(res, event, { kind: 'timeline_event', playerId: req.player.id })) return;
  req.player.timeline.push({ year: String(year), event: String(event) });
  broadcast('players', { playerId: req.player.id });
  res.status(201).json({ timeline: req.player.timeline });
});

// Children keep their football life: stats edits and drills stay open.
// Passing `season` (e.g. "2024/25") files the numbers into season history
// instead of the current season.
playerRouter.post('/stats', (req, res) => {
  const FIELDS = ['appearances', 'goals', 'assists', 'paceKmh', 'passCompletionPct', 'duelSuccessPct', 'cleanSheets'];
  const updates = {};
  for (const f of FIELDS) {
    if (req.body?.[f] !== undefined) {
      const v = Number(req.body[f]);
      if (Number.isNaN(v) || v < 0) return res.status(400).json({ error: 'BAD_STAT', field: f });
      updates[f] = v;
    }
  }
  const season = typeof req.body?.season === 'string' && req.body.season.trim() ? req.body.season.trim() : null;
  if (season) {
    req.player.seasonHistory ??= [];
    const existing = req.player.seasonHistory.find((s) => s.season === season);
    if (existing) Object.assign(existing, updates);
    else req.player.seasonHistory.push({ season, appearances: 0, goals: 0, assists: 0, ...updates });
    req.player.seasonHistory.sort((a, b) => (a.season < b.season ? 1 : -1));
  } else {
    req.player.stats = { appearances: 0, goals: 0, assists: 0, ...req.player.stats, ...updates };
  }
  recordActivity(req.player);
  broadcast('players', { playerId: req.player.id });
  res.json({ stats: req.player.stats, seasonHistory: req.player.seasonHistory ?? [] });
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
      completed: req.player.drills.includes(d.id),
      best: req.player.drillResults
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
  if (!req.player.drills.includes(drill.id)) req.player.drills.push(drill.id);
  if (numeric !== null) {
    req.player.drillResults.push({
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
  recordActivity(req.player);
  broadcast('players', { playerId: req.player.id });
  res.json({ drills: req.player.drills, drillResults: req.player.drillResults });
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
  req.player.programme = { track: track.key, startedAt: Date.now(), completed: [] };
  persist();
  broadcast('players', { playerId: req.player.id });
  res.status(201).json({ current: programmeProgress(req.player) });
});

playerRouter.post('/programme/sessions/:id/complete', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  if (!req.player.programme) return res.status(409).json({ error: 'NO_PROGRAMME', message: 'Pick a training track first.' });
  const track = PROGRAMME_TRACKS[req.player.programme.track];
  const session = track?.sessions.find((x) => x.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
  req.player.programme.completed.push({ sessionId: session.id, ts: Date.now() });
  recordActivity(req.player); // programme work feeds streaks + the weekly goal
  broadcast('players', { playerId: req.player.id });
  res.json({ current: programmeProgress(req.player) });
});

// Honest context, never a leaderboard: percentiles vs the amateur/semi-pro
// cohort in the same position group. Small cohorts return null.
playerRouter.get('/benchmarks', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  const cohort = db.players.filter((c) => c.id !== req.player.id && inCohort(req.player, c));
  const drillBests = (playerX, drillId, lowerIsBetter) => {
    const results = (playerX.drillResults ?? []).filter((r) => r.drillId === drillId);
    if (!results.length) return null;
    const values = results.map((r) => r.value);
    return lowerIsBetter ? Math.min(...values) : Math.max(...values);
  };
  const drills = DRILLS.map((d) => {
    const mine = drillBests(req.player, d.id, d.lowerIsBetter);
    if (mine === null) return null;
    const cohortValues = cohort.map((c) => drillBests(c, d.id, d.lowerIsBetter)).filter((v) => v !== null);
    return { drillId: d.id, name: d.name, metric: d.metric, unit: d.unit, value: mine, percentile: percentileAmong(mine, cohortValues, d.lowerIsBetter) };
  }).filter(Boolean);
  const statKeys = ['goals', 'assists', 'appearances', 'passCompletionPct', 'duelSuccessPct'];
  const stats = statKeys.map((k) => {
    const mine = req.player.stats?.[k];
    if (typeof mine !== 'number') return null;
    const cohortValues = cohort.map((c) => c.stats?.[k]).filter((v) => typeof v === 'number');
    return { stat: k, value: mine, percentile: percentileAmong(mine, cohortValues, false) };
  }).filter(Boolean);
  res.json({ cohortSize: cohort.length, note: 'Percentiles vs amateur & semi-pro players in your position group — context, not competition.', drills, stats });
});

// The opportunity radar: the 50km rule, pointed the player's way.
playerRouter.get('/opportunities', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  if (!req.player.location) return res.json({ clubs: [], note: 'Set your location to see clubs within reach.' });
  const clubs = db.orgs
    .filter((o) => o.level === 'grassroots' && o.location)
    .map((o) => ({ org: o, distanceKm: Math.round(haversineKm(o.location, req.player.location) * 10) / 10 }))
    .filter((x) => x.distanceKm <= GRASSROOTS_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .map(({ org, distanceKm }) => ({
      id: org.id, name: org.name, city: org.location.city ?? '', distanceKm,
      verified: org.verified, safeguardingCertified: safeguardingCertified(org),
      ...pathwayRecord(org),
      lookingFor: org.lookingFor ?? [],
      openTrials: db.openTrials.filter((t) => t.orgId === org.id && t.date >= new Date().toISOString().slice(0, 10))
        .map(({ registrations, ...t }) => ({ ...t, registered: (registrations ?? []).some((r) => r.playerId === req.player.id) })),
    }));
  res.json({ radiusKm: GRASSROOTS_RADIUS_KM, clubs, lookingForYou: clubs.filter((c) => c.lookingFor.includes(req.player.position)).length });
});

// Open trial days near the player. Adults register directly; minors see them
// but registration belongs to the guardian — Scout → Parent, always.
playerRouter.post('/open-trials/:id/register', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  if (guardianManagedOnly(req, res)) return;
  const trial = db.openTrials.find((t) => t.id === req.params.id);
  if (!trial) return res.status(404).json({ error: 'OPEN_TRIAL_NOT_FOUND' });
  const org = db.orgs.find((o) => o.id === trial.orgId);
  if (!org || !req.player.location || !org.location || haversineKm(org.location, req.player.location) > GRASSROOTS_RADIUS_KM) {
    return res.status(403).json({ error: 'OUT_OF_RADIUS', message: 'Open days are local — this one is beyond 50km of you.' });
  }
  trial.registrations ??= [];
  if (trial.registrations.some((r) => r.playerId === req.player.id)) return res.status(409).json({ error: 'ALREADY_REGISTERED' });
  trial.registrations.push({ id: nextId('otr'), playerId: req.player.id, playerName: req.player.name, byGuardian: false, ts: Date.now() });
  ledgerAppend({ type: 'open_trial_registration', playerId: req.player.id, orgId: org.id, orgName: org.name, userId: trial.createdByUserId ?? null, scoutName: 'open day' });
  notify({ kind: 'org_user', id: trial.createdByUserId }, 'open_trial', `${req.player.name} registered for "${trial.title}".`, trial.id);
  persist();
  res.status(201).json({ registered: true });
});

// First Team Seekers: Grassroots' own cohort — need-based, free, never
// purchasable. Adults set it themselves; guardians set it for children.
playerRouter.post('/first-team-seeker', (req, res) => {
  if (grassrootsOnly(req, res)) return;
  if (guardianManagedOnly(req, res)) return;
  req.player.firstTeamSeeker = !!req.body?.enabled;
  persist();
  broadcast('players', { playerId: req.player.id });
  res.json({ firstTeamSeeker: req.player.firstTeamSeeker });
});

// Coach vouches: a named, verified local coach is the most valuable
// credential an amateur can hold. The coach proves mailbox control with a
// one-time code; the text is moderated like every other message.
function createVouchRequest(player, { coachName, coachEmail, role }, res) {
  if (!coachName || !coachEmail || !coachEmail.includes('@')) {
    return res.status(400).json({ error: 'COACH_DETAILS_REQUIRED', message: 'Name the coach and their email address.' });
  }
  const vouch = {
    id: nextId('vch'), playerId: player.id, playerName: player.name,
    coachName: String(coachName).trim(), coachEmail: String(coachEmail).trim(), role: String(role ?? 'Coach').trim(),
    status: 'pending', code: randomCode(8), text: null, seasons: null, ts: Date.now(), publishedAt: null,
  };
  db.vouches.push(vouch);
  void mailer.send({
    to: vouch.coachEmail,
    subject: `Reference request for ${player.name} on ScoutBox`,
    text: `Hi ${vouch.coachName},

${player.name} has asked you for a coach reference on ScoutBox Grassroots.

Your one-time reference code is ${vouch.code}. Submitting with it confirms this mailbox is yours; your name and role will appear with the reference on ${player.name}'s profile.

References are screened by moderation and reviewed by Trust & Safety.`,
  });
  persist();
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
    scoutViews: db.ledger.filter((l) => l.playerId === p.id && l.type === 'view').length,
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
  db.blocks.push({ id: nextId('blk'), playerId: req.player.id, orgId, by: 'player', reason: reason || '', ts: Date.now() });
  ledgerAppend({ type: 'org_blocked_by_player', playerId: req.player.id, orgId, orgName: db.orgs.find((o) => o.id === orgId)?.name ?? orgId, userId: null, scoutName: 'player' });
  broadcast('players');
  res.status(201).json({ blocked: true });
});

// ------------------------------------------------- pairing, prefs, export
// Child device pairing: the guardian mints a short-lived code; the child's
// device exchanges it for their limited login.
guardianRouter.post('/children/:id/pairing-code', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  // Random, not id-derived: pairing codes must never be guessable.
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join('');
  db.pairingCodes = db.pairingCodes.filter((c) => c.playerId !== child.id); // one live code per child
  db.pairingCodes.push({ code, playerId: child.id, expiresAt: Date.now() + 15 * 60 * 1000 });
  res.status(201).json({ code, expiresAt: Date.now() + 15 * 60 * 1000 });
});

app.post('/auth/player/pair', (req, res) => {
  const { code } = req.body || {};
  const entry = db.pairingCodes.find((c) => c.code === String(code ?? '').toUpperCase());
  if (!entry || entry.expiresAt < Date.now()) return res.status(404).json({ error: 'CODE_INVALID', message: 'That pairing code is wrong or expired — ask your parent/guardian for a fresh one.' });
  db.pairingCodes = db.pairingCodes.filter((c) => c !== entry);
  const p = findPlayer(entry.playerId);
  res.json({ playerId: p.id, name: p.name, token: createSession('player', p.id) });
});

// Device push-token registration (used when EXPO_ACCESS_TOKEN switches the
// push adapter live; harmless no-op storage in dev).
app.post('/push/register', (req, res) => {
  const session = sessionFor(req);
  if (!session) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'TOKEN_REQUIRED' });
  db.pushTokens = db.pushTokens.filter((t) => !(t.kind === session.kind && t.refId === session.refId && t.token === token));
  db.pushTokens.push({ kind: session.kind, refId: session.refId, token, ts: Date.now() });
  persist();
  res.status(201).json({ registered: true });
});

// Guardian view of open trial days near a child, and registration — the
// guardian decides, the child never talks to anyone. Minor registrations
// only reach clubs allowed to see the child (verified + local).
guardianRouter.get('/children/:id/open-trials', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  if (!child.location) return res.json({ openTrials: [], note: 'Set a location on the profile to see local open days.' });
  const list = db.openTrials
    .map((t) => ({ t, org: db.orgs.find((o) => o.id === t.orgId) }))
    .filter(({ org }) => org?.level === 'grassroots' && org.location && haversineKm(org.location, child.location) <= GRASSROOTS_RADIUS_KM)
    .filter(({ org }) => visibleToOrg(child, org)) // only clubs that may see the child at all
    .map(({ t, org }) => ({
      id: t.id, title: t.title, date: t.date, venue: t.venue, ageGroup: t.ageGroup, positions: t.positions,
      orgName: t.orgName, verified: org.verified, safeguardingCertified: safeguardingCertified(org),
      distanceKm: Math.round(haversineKm(org.location, child.location) * 10) / 10,
      registered: (t.registrations ?? []).some((r) => r.playerId === child.id),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  res.json({ openTrials: list });
});

guardianRouter.post('/open-trials/:id/register', (req, res) => {
  const child = findPlayer(req.body?.childId);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  const trial = db.openTrials.find((t) => t.id === req.params.id);
  if (!trial) return res.status(404).json({ error: 'OPEN_TRIAL_NOT_FOUND' });
  const org = db.orgs.find((o) => o.id === trial.orgId);
  if (!org || !visibleToOrg(child, org)) {
    return res.status(403).json({ error: 'VERIFIED_CLUBS_ONLY', message: 'Only verified, local clubs can receive an under-18 registration.' });
  }
  trial.registrations ??= [];
  if (trial.registrations.some((r) => r.playerId === child.id)) return res.status(409).json({ error: 'ALREADY_REGISTERED' });
  trial.registrations.push({ id: nextId('otr'), playerId: child.id, playerName: child.name, byGuardian: true, guardianId: req.guardian.id, ts: Date.now() });
  ledgerAppend({ type: 'open_trial_registration_by_guardian', playerId: child.id, orgId: org.id, orgName: org.name, userId: trial.createdByUserId ?? null, scoutName: 'open day' });
  notify({ kind: 'org_user', id: trial.createdByUserId }, 'open_trial', `${child.name} (via guardian) registered for "${trial.title}".`, trial.id);
  notify({ kind: 'player', id: child.id }, 'open_trial', `Your parent/guardian registered you for ${org.name}'s open day "${trial.title}" — good luck!`, trial.id);
  persist();
  res.status(201).json({ registered: true });
});

guardianRouter.post('/children/:id/first-team-seeker', (req, res) => {
  const child = findPlayer(req.params.id);
  if (!child || !req.guardian.childIds.includes(child.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  if (child.level === 'pro') return res.status(403).json({ error: 'GRASSROOTS_ONLY' });
  child.firstTeamSeeker = !!req.body?.enabled;
  persist();
  broadcast('players', { playerId: child.id });
  res.json({ firstTeamSeeker: child.firstTeamSeeker });
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
    const target = getTarget(req);
    if (req.method === 'POST') {
      const { quietStart, quietEnd, schoolHoursMute } = req.body || {};
      target.notificationPrefs = {
        quietStart: quietStart ?? target.notificationPrefs?.quietStart ?? null,
        quietEnd: quietEnd ?? target.notificationPrefs?.quietEnd ?? null,
        schoolHoursMute: schoolHoursMute ?? target.notificationPrefs?.schoolHoursMute ?? null,
      };
      persist();
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
    requests: db.requests.filter((r) => r.playerId === p.id).map(({ orgId, userId, ...r }) => r),
    threads: db.channels.filter((c) => c.playerId === p.id).map((c) => channelViewFor(c, 'player')),
    notifications: notificationsFor('player', p.id),
    insights: insightsFor(p.id),
    ledgerEvents: db.ledger.filter((l) => l.playerId === p.id),
  };
}

function deletePlayerData(playerId) {
  const p = findPlayer(playerId);
  if (!p) return false;
  for (const m of p.media) storage.delete(m.id);
  db.sessions = db.sessions.filter((s) => !(s.kind === 'player' && s.refId === playerId));
  db.players = db.players.filter((x) => x.id !== playerId);
  db.requests = db.requests.filter((r) => r.playerId !== playerId);
  db.channels = db.channels.filter((c) => c.playerId !== playerId);
  db.trials = db.trials.filter((t) => t.playerId !== playerId);
  db.notifications = db.notifications.filter((n) => !(n.audience.kind === 'player' && n.audience.id === playerId));
  db.pairingCodes = db.pairingCodes.filter((c) => c.playerId !== playerId);
  db.savedSearches = db.savedSearches; // org data unaffected
  for (const g of db.guardians) g.childIds = g.childIds.filter((id) => id !== playerId);
  // Ledger rows stay (append-only audit + attribution) but carry only ids.
  broadcast('players');
  persist();
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
    guardian: guardianView(req.guardian),
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
app.get('/orgs/directory', (_req, res) => {
  res.json(
    db.orgs.filter((o) => o.type === 'club').map((o) => {
      const trials = db.trials.filter((t) => t.orgId === o.id);
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
    })
  );
});

// Coach reference submission: the code from the emailed request proves the
// mailbox; the text passes the same moderation screen as every message.
app.post('/vouch/submit', (req, res) => {
  const { code, text, seasons } = req.body || {};
  const vouch = db.vouches.find((v) => v.code === String(code ?? '').trim().toUpperCase() && v.status === 'pending');
  if (!vouch) return res.status(404).json({ error: 'CODE_INVALID', message: 'That reference code is wrong or already used.' });
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
  if (!moderateOrRefuse(res, text, { kind: 'coach_vouch', playerId: vouch.playerId })) return;
  vouch.text = String(text).trim().slice(0, 400);
  vouch.seasons = seasons ? String(seasons).trim().slice(0, 40) : null;
  vouch.status = 'published';
  vouch.publishedAt = Date.now();
  vouch.code = null; // single use
  const player = findPlayer(vouch.playerId);
  notify({ kind: 'player', id: vouch.playerId }, 'vouch', `⭐ ${vouch.coachName} published a coach reference on your profile.`, vouch.id);
  if (player?.guardianId) notify({ kind: 'guardian', id: player.guardianId }, 'vouch', `${vouch.coachName} published a coach reference on ${player.name}'s profile.`, vouch.id);
  persist();
  broadcast('players', { playerId: vouch.playerId });
  res.status(201).json({ published: true });
});

// ------------------------------------------------------ admin (T&S) console
// ScoutBox staff only. Prototype auth: x-admin-key (ADMIN_KEY env).
const ADMIN_KEY = process.env.ADMIN_KEY || 'scoutbox-admin';
const adminRouter = express.Router();
app.use('/admin', (req, res, next) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'ADMIN_KEY_REQUIRED' });
  next();
}, adminRouter);

adminRouter.get('/overview', (_req, res) => {
  res.json({
    players: db.players.length,
    guardians: db.guardians.length,
    orgs: db.orgs.length,
    openReports: db.reports.filter((r) => r.status === 'pending_review').length,
    blocks: db.blocks.length,
    moderationHits: db.moderationLog.length,
    channels: db.channels.length,
    signings: db.signings.length,
    invoices: db.invoices.length,
    emailsSent: db.outbox.length,
    pushesSent: db.pushLog.length,
    sessions: db.sessions.length,
    storageEngine: store.engine,
    groomingEscalations: db.moderationLog.filter((m) => m.severity === 'grooming').length,
    persisted: snapshotLoaded,
  });
});

// Triage order: urgent first, then oldest-pending first, then resolved.
adminRouter.get('/reports', (_req, res) => {
  const rank = (r) => (r.status === 'pending_review' ? (r.urgent ? 0 : 1) : 2);
  res.json(db.reports.slice().sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? a.ts - b.ts : b.ts - a.ts)));
});

adminRouter.get('/outbox', (_req, res) => res.json(db.outbox.slice().reverse()));
adminRouter.get('/push-log', (_req, res) => res.json(db.pushLog.slice(-200).reverse()));
adminRouter.get('/invoices', (_req, res) => res.json(db.invoices.slice().reverse()));
adminRouter.get('/vouches', (_req, res) => res.json(db.vouches.map(({ code, ...v }) => v).reverse()));
adminRouter.post('/vouches/:id/revoke', (req, res) => {
  const vouch = db.vouches.find((v) => v.id === req.params.id);
  if (!vouch) return res.status(404).json({ error: 'VOUCH_NOT_FOUND' });
  vouch.status = 'revoked';
  persist();
  broadcast('players', { playerId: vouch.playerId });
  res.json({ revoked: true });
});

adminRouter.post('/reports/:id/resolve', (req, res) => {
  const report = db.reports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'REPORT_NOT_FOUND' });
  if (report.status !== 'pending_review') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
  const { outcome, action } = req.body || {};
  if (!outcome || !String(outcome).trim()) return res.status(400).json({ error: 'OUTCOME_REQUIRED' });
  report.status = action === 'dismiss' ? 'resolved' : 'resolved';
  report.resolvedAt = Date.now();
  report.outcome = String(outcome).trim();
  if (action === 'suspend_org' && report.targetOrgId) {
    const org = db.orgs.find((o) => o.id === report.targetOrgId);
    if (org) org.suspended = true;
  }
  const audienceKind = report.by === 'org_user' ? 'org_user' : report.by;
  notify({ kind: audienceKind, id: report.byId }, 'report_resolved', `Your report was reviewed: ${report.outcome}`, report.id);
  persist();
  res.json(report);
});

adminRouter.get('/clubs', (_req, res) => {
  res.json(db.orgs.map((o) => ({ ...o, safeguardingCertified: safeguardingCertified(o) })));
});

adminRouter.post('/clubs/:id/verification', (req, res) => {
  const org = db.orgs.find((o) => o.id === req.params.id);
  if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
  const { verified, safeguardingContractSigned, verifiedDomain, suspended } = req.body || {};
  if (verified !== undefined) org.verified = !!verified;
  if (safeguardingContractSigned !== undefined) org.safeguardingContractSigned = !!safeguardingContractSigned;
  if (verifiedDomain !== undefined) org.verifiedDomain = verifiedDomain || null;
  if (suspended !== undefined) org.suspended = !!suspended;
  persist();
  broadcast('players'); // visibility rules may have changed
  res.json({ ...org, safeguardingCertified: safeguardingCertified(org) });
});

adminRouter.get('/guardians', (_req, res) => {
  res.json({ guardians: db.guardians, idvQueue: db.idvQueue ?? [] });
});

adminRouter.post('/guardians/:id/idv', (req, res) => {
  const g = db.guardians.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'GUARDIAN_NOT_FOUND' });
  g.idVerified = !!req.body?.approved;
  const entry = (db.idvQueue ?? []).find((q) => q.guardianId === g.id);
  if (entry) entry.status = g.idVerified ? 'approved' : 'revoked';
  persist();
  res.json(g);
});

adminRouter.get('/blocks', (_req, res) => res.json(db.blocks.slice().reverse()));

adminRouter.post('/blocks/:id/lift', (req, res) => {
  const idx = db.blocks.findIndex((b) => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'BLOCK_NOT_FOUND' });
  const [lifted] = db.blocks.splice(idx, 1);
  persist();
  broadcast('players');
  res.json({ lifted });
});

adminRouter.get('/moderation', (_req, res) => res.json(db.moderationLog.slice().reverse()));

// Thread audit — the "all communications logged" promise, made inspectable.
adminRouter.get('/channels', (_req, res) => res.json(db.channels.map((c) => ({ ...c }))));

// Serve uploaded media (any authenticated party with profile access could
// reach this in production; prototype serves by id).
app.get('/media/:id', (req, res) => {
  if (!/^[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: 'BAD_MEDIA_ID' });
  const blob = storage.read(req.params.id);
  if (!blob) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
  res.set('Content-Type', blob.contentType).send(blob.buffer);
});

// ---------------------------------------------------- static app hosting
// Single-container deploys: the Docker build drops the built club app into
// public/club and the T&S console into public/admin, and this serves them
// alongside the API. Local dev keeps using the Vite/Expo dev servers.
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
for (const [route, dir] of [['/app', 'club'], ['/console', 'admin'], ['/grassroots', 'grassroots']]) {
  const full = path.join(PUBLIC_DIR, dir);
  if (fs.existsSync(path.join(full, 'index.html'))) {
    app.use(route, express.static(full));
    app.get(`${route}/*`, (_req, res) => res.sendFile(path.join(full, 'index.html')));
    console.log(`serving ${dir} app at ${route}`);
  }
}

// ------------------------------------------------------------------- start
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: err.message });
});

app.listen(PORT, () => {
  console.log(`scoutbox-server listening on :${PORT} — ${db.players.length} players, ${db.orgs.length} orgs seeded`);
});
