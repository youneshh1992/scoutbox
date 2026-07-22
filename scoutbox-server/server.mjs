// ScoutBox sync backend (Milestone 2).
// Every deck rule is enforced HERE, not in the frontends — the product's
// claims depend on the API refusing, not the UI hiding.
//
// Storage is in-memory, seeded from seed.mjs (restart = reset). The API
// surface is designed so storage can swap to Postgres without changes.

import express from 'express';
import cors from 'cors';
import { buildSeed } from './seed.mjs';
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
} from './domain.mjs';

const PORT = process.env.PORT || 4000;
const db = buildSeed();

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------- live sync
const sseClients = new Set();

function broadcast(event, payload = {}) {
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
let idCounter = 1000;
const nextId = (prefix) => `${prefix}-${++idCounter}`;

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

// Public view of a player for a given org. Applies the under-18 wall and
// player-controlled medical sharing.
function playerViewForOrg(player, org) {
  if (!visibleToOrg(player, org)) return null;
  const { medical, ...rest } = player;
  return {
    ...rest,
    age: ageOn(player.dob),
    trustScore: computeTrustScore(player),
    medical: medical.shared
      ? medical
      : { shared: false, records: [], conditionStatus: 'not_shared', note: 'Medical data is player-controlled and has not been shared.' },
  };
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
// Prototype auth: the player app sends x-player-id. Production swaps this
// for real sessions without changing the API surface.

// Adults-only launch: the API itself rejects under-age sign-ups.
app.post('/auth/player/signup', (req, res) => {
  const { name, dob, country = 'GB', position, foot } = req.body || {};
  if (!name || !dob) return res.status(400).json({ error: 'NAME_AND_DOB_REQUIRED' });
  const required = adultAgeFor(country);
  if (ageOn(dob) < required) {
    return res.status(403).json({
      error: 'ADULTS_ONLY',
      message: `ScoutBox is launching adults-only. You must be ${required}+ in your country to create a profile.`,
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
    medical: { shared: false, records: [], conditionStatus: 'unknown' },
  };
  db.players.push(p);
  broadcast('players');
  res.status(201).json({ playerId: p.id, player: p });
});

app.post('/auth/player/login', (req, res) => {
  const p = findPlayer(req.body?.playerId);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  res.json({ playerId: p.id, name: p.name });
});

function playerAuth(req, res, next) {
  const p = findPlayer(req.headers['x-player-id']);
  if (!p) return res.status(401).json({ error: 'PLAYER_AUTH_REQUIRED' });
  req.player = p;
  next();
}

// ---------------------------------------------------------------- org auth
app.get('/orgs', (_req, res) => {
  res.json(db.orgs.map(({ id, name, type, plan, trustedPartner }) => ({ id, name, type, plan, trustedPartner })));
});

app.post('/auth/org/login', (req, res) => {
  const { orgId, scoutName } = req.body || {};
  const org = db.orgs.find((o) => o.id === orgId);
  if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
  if (!scoutName || !scoutName.trim()) {
    // Accountability by user: no anonymous / shared workspace access.
    return res.status(400).json({ error: 'SCOUT_NAME_REQUIRED', message: 'Every session is attributed to a named individual.' });
  }
  let user = db.users.find((u) => u.orgId === orgId && u.name.toLowerCase() === scoutName.trim().toLowerCase());
  if (!user) {
    user = { id: nextId('usr'), orgId, name: scoutName.trim(), createdAt: Date.now() };
    db.users.push(user);
  }
  res.json({ userId: user.id, org });
});

// Accountability by user: every org request must carry an individual user id.
function orgAuth(req, res, next) {
  const orgId = req.headers['x-org-id'];
  const userId = req.headers['x-user-id'];
  const org = db.orgs.find((o) => o.id === orgId);
  if (!org) return res.status(401).json({ error: 'ORG_AUTH_REQUIRED' });
  if (!userId) {
    return res.status(401).json({
      error: 'USER_REQUIRED',
      message: 'Requests must be attributed to an individual user. Shared org accounts are refused.',
    });
  }
  const user = db.users.find((u) => u.id === userId && u.orgId === orgId);
  if (!user) return res.status(401).json({ error: 'USER_UNKNOWN' });
  req.org = org;
  req.orgUser = user;
  next();
}

const orgRouter = express.Router();
app.use('/org', orgAuth, orgRouter);

// ----------------------------------------------------------------- search
orgRouter.get('/players', (req, res) => {
  const { q, position, academyPlus, availability } = req.query;
  let list = db.players
    .filter((p) => visibleToOrg(p, req.org)) // the under-18 wall, at the source
    .map((p) => playerViewForOrg(p, req.org));

  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter(
      (p) => p.name.toLowerCase().includes(needle) || (p.city || '').toLowerCase().includes(needle) || (p.country || '').toLowerCase().includes(needle)
    );
  }
  if (position) list = list.filter((p) => p.position === position);
  if (availability) list = list.filter((p) => p.availability === availability);
  if (academyPlus === 'true') list = list.filter((p) => p.academyPlus);

  // Academy+ is a boosted cohort: opted-in players surface first.
  list.sort((a, b) => (b.academyPlus ? 1 : 0) - (a.academyPlus ? 1 : 0) || b.trustScore - a.trustScore);
  res.json(list);
});

orgRouter.get('/players/:id', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!visibleToOrg(p, req.org)) {
    // The under-18 wall: for an agency, a minor does not exist on any endpoint.
    return res.status(403).json({ error: 'UNDER_18_WALL', message: 'Agency accounts cannot view minors.' });
  }
  ledgerAppend({ type: 'view', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  const view = playerViewForOrg(p, req.org);
  const similar = db.players
    .filter((c) => c.id !== p.id && visibleToOrg(c, req.org))
    .map((c) => ({ playerId: c.id, name: c.name, position: c.position, score: similarityScore(p, c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const archetypes = db.archetypes
    .map((a) => ({ archetypeId: a.id, label: a.label, score: similarityScore(p, a) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  res.json({ ...view, similarPlayers: { note: 'Statistical similarity — a lead, not a verdict.', players: similar, archetypes } });
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
// An org can only file a request; contact unlocks when the player accepts.
orgRouter.post('/players/:id/request', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL', message: 'Agency accounts cannot contact minors.' });
  const { type, message } = req.body || {};
  if (!['contact', 'trial'].includes(type)) return res.status(400).json({ error: 'TYPE_MUST_BE_CONTACT_OR_TRIAL' });

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

  const request = {
    id: nextId('req'),
    playerId: p.id,
    orgId: req.org.id,
    orgName: req.org.name,
    orgType: req.org.type,
    trustedPartner: req.org.trustedPartner,
    userId: req.orgUser.id,
    scoutName: req.orgUser.name,
    type,
    message: message || '',
    status: 'pending',
    createdAt: Date.now(),
    contactChannel: null, // stays null until the player accepts
  };
  db.requests.push(request);
  ledgerAppend({ type: `${type}_request`, playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  broadcast('inbox', { playerId: p.id });
  res.status(201).json({ ok: true, requestId: request.id, status: 'pending' });
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
  };
  trial.status = 'reported';
  trial.report = report;

  // Filed reports sync to the player profile and raise Trust Score
  // (institutional corroboration).
  const p = findPlayer(trial.playerId);
  p.trialReports.push(report);
  ledgerAppend({ type: 'trial_report', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  broadcast('players', { playerId: p.id });
  res.status(201).json({ ok: true, report, playerTrustScore: computeTrustScore(p) });
});

orgRouter.post('/players/:id/signing', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
  const row = ledgerAppend({ type: 'signing', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  res.status(201).json({ ok: true, ledgerId: row.id });
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
  res.json({ ...req.player, age: ageOn(req.player.dob), trustScore: computeTrustScore(req.player), trust: trustBreakdown(req.player) });
});

// Scout Inbox — org identity is summarised, org ids are stripped; the player
// sees who wants them and decides. No message thread exists until acceptance.
playerRouter.get('/inbox', (req, res) => {
  res.json(
    db.requests
      .filter((r) => r.playerId === req.player.id)
      .map(({ orgId, userId, ...visible }) => visible)
      .slice()
      .reverse()
  );
});

playerRouter.post('/requests/:id/respond', (req, res) => {
  const request = db.requests.find((r) => r.id === req.params.id && r.playerId === req.player.id);
  if (!request) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'ALREADY_RESPONDED' });
  const { accept } = req.body || {};
  request.status = accept ? 'accepted' : 'declined';
  request.respondedAt = Date.now();

  if (accept) {
    // Only now does a contact channel exist.
    request.contactChannel = nextId('chan');
    ledgerAppend({ type: `${request.type}_accepted`, playerId: req.player.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    if (request.type === 'trial') {
      db.trials.push({
        id: nextId('trial'),
        requestId: request.id,
        playerId: req.player.id,
        playerName: req.player.name,
        orgId: request.orgId,
        orgName: request.orgName,
        scoutName: request.scoutName,
        acceptedAt: Date.now(),
        status: 'awaiting_report', // mandatory report gate
      });
    }
  } else {
    ledgerAppend({ type: `${request.type}_declined`, playerId: req.player.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
  }
  broadcast('requests', { playerId: req.player.id });
  const { orgId, userId, ...visible } = request;
  res.json(visible);
});

// Academy+ is opt-in only and player-controlled.
playerRouter.post('/academyplus', (req, res) => {
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

playerRouter.post('/media', (req, res) => {
  const { title, kind = 'video' } = req.body || {};
  if (!title) return res.status(400).json({ error: 'TITLE_REQUIRED' });
  const item = { id: nextId('media'), title, kind, uploadedAt: new Date().toISOString() };
  req.player.media.push(item);
  broadcast('players', { playerId: req.player.id });
  res.status(201).json({ media: item, trustScore: computeTrustScore(req.player) });
});

// Medical data is player-controlled per data-protection law.
playerRouter.post('/medical/share', (req, res) => {
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

playerRouter.post('/availability', (req, res) => {
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
  ledgerAppend({ type: 'attendance_verified', playerId: req.player.id, orgId: null, orgName: 'ScoutBox', userId: null, scoutName: 'system' });
  broadcast('players', { playerId: req.player.id });
  res.status(201).json({ attendance: item, trustScore: computeTrustScore(req.player) });
});

playerRouter.post('/timeline', (req, res) => {
  const { year, event } = req.body || {};
  if (!year || !event) return res.status(400).json({ error: 'YEAR_AND_EVENT_REQUIRED' });
  req.player.timeline.push({ year: String(year), event: String(event) });
  broadcast('players', { playerId: req.player.id });
  res.status(201).json({ timeline: req.player.timeline });
});

// ------------------------------------------------------------------- start
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: err.message });
});

app.listen(PORT, () => {
  console.log(`scoutbox-server listening on :${PORT} — ${db.players.length} players, ${db.orgs.length} orgs seeded`);
});
