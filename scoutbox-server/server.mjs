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
  trustTier,
  computeStreak,
  weeklyGoal,
  nextActions,
} from './domain.mjs';

const PORT = process.env.PORT || 4000;
const db = buildSeed();

// Normalise media items (older shapes) + load the seeded sample clips.
for (const p of db.players) {
  for (const m of p.media) {
    m.views ??= 0;
    m.tags ??= {};       // tag → count (from scouts, aggregated anonymously)
    m.verifiedClip ??= null; // attendance id when footage is provably from a confirmed fixture
    m.url ??= null;
  }
}

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
    db.mediaBlobs[media.id] = { dataUrl: `data:video/webm;base64,${data.toString('base64')}` };
    media.url = `/media/${media.id}`;
    if (sample.verify && player.attendance[0]) media.verifiedClip = player.attendance[0].id;
  } catch {
    // assets optional — Film Room just starts empty without them
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' })); // media uploads travel as data URLs

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

function isBlocked(playerId, orgId) {
  return db.blocks.some((b) => b.playerId === playerId && b.orgId === orgId);
}

// ------------------------------------------------------------ notifications
// In-app notification feed. audience = {kind: 'player'|'guardian'|'org_user', id}.
// (Push / email delivery is a production integration behind this same record.)
function notify(audience, type, text, refId = null) {
  const n = { id: nextId('ntf'), ts: Date.now(), audience, type, text, refId, read: false };
  db.notifications.push(n);
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
    db.moderationLog.push({ id: nextId('mod'), ts: Date.now(), context, flags: check.flags });
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
// Prototype auth: the player app sends x-player-id. Production swaps this
// for real sessions without changing the API surface.

// Self sign-up is adults only. Under-18 accounts are OWNED by a verified
// guardian and can only be created through the guardian flow below — the API
// itself refuses a minor self-signup.
app.post('/auth/player/signup', (req, res) => {
  const { name, dob, country = 'GB', position, foot, password } = req.body || {};
  if (!name || !dob) return res.status(400).json({ error: 'NAME_AND_DOB_REQUIRED' });
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
    password: password || null,
    medical: { shared: false, records: [], conditionStatus: 'unknown' },
  };
  db.players.push(p);
  broadcast('players');
  res.status(201).json({ playerId: p.id, player: p });
});

// Prototype credential support: a profile created with a password requires it
// at login (plain-text store — production swaps in real hashing + sessions).
app.post('/auth/player/login', (req, res) => {
  const p = findPlayer(req.body?.playerId);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (p.password && p.password !== req.body?.password) {
    return res.status(401).json({ error: 'BAD_PASSWORD', message: 'This profile is password-protected.' });
  }
  res.json({ playerId: p.id, name: p.name });
});

function playerAuth(req, res, next) {
  const p = findPlayer(req.headers['x-player-id']);
  if (!p) return res.status(401).json({ error: 'PLAYER_AUTH_REQUIRED' });
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

app.post('/auth/guardian/signup', (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'NAME_AND_EMAIL_REQUIRED' });
  const g = {
    id: nextId('gd'),
    name,
    email,
    idVerified: false,
    disclaimerAccepted: false,
    childIds: [],
  };
  db.guardians.push(g);
  res.status(201).json({ guardianId: g.id, guardian: g });
});

app.post('/auth/guardian/login', (req, res) => {
  const g = db.guardians.find((x) => x.id === req.body?.guardianId || x.email === req.body?.email);
  if (!g) return res.status(404).json({ error: 'GUARDIAN_NOT_FOUND' });
  res.json({ guardianId: g.id, guardian: g });
});

function guardianAuth(req, res, next) {
  const g = db.guardians.find((x) => x.id === req.headers['x-guardian-id']);
  if (!g) return res.status(401).json({ error: 'GUARDIAN_AUTH_REQUIRED' });
  req.guardian = g;
  next();
}

const guardianRouter = express.Router();
app.use('/guardian', guardianAuth, guardianRouter);

// Prototype ID verification: an attestation endpoint. Production integrates a
// document + liveness IDV provider behind this same call.
guardianRouter.post('/verify-id', (req, res) => {
  const { documentType, documentRef } = req.body || {};
  if (!documentType || !documentRef) {
    return res.status(400).json({ error: 'DOCUMENT_REQUIRED', message: 'ID verification needs a document type and reference.' });
  }
  req.guardian.idVerified = true;
  res.json({ idVerified: true });
});

guardianRouter.post('/disclaimer', (req, res) => {
  if (req.body?.accepted !== true) {
    return res.status(400).json({ error: 'DISCLAIMER_NOT_ACCEPTED' });
  }
  req.guardian.disclaimerAccepted = true;
  res.json({ disclaimerAccepted: true });
});

guardianRouter.get('/me', (req, res) => res.json(req.guardian));

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
    medical: { shared: false, records: [], conditionStatus: 'unknown' },
  };
  db.players.push(p);
  req.guardian.childIds.push(p.id);
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
  const { accept } = req.body || {};
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
        proposedDate: details.proposedDate ?? null,
        venue: details.venue ?? null,
        notes: details.notes ?? '',
        // The mandatory report is due 7 days after the trial (or acceptance).
        reportDueAt: (details.proposedDate ? new Date(details.proposedDate).getTime() : Date.now()) + 7 * 24 * 3600 * 1000,
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
  // Reporters hear back. Prototype review resolves on a timer; production is
  // a human trust-and-safety queue behind the same status fields.
  setTimeout(() => {
    if (report.status !== 'pending_review') return;
    report.status = 'resolved';
    report.resolvedAt = Date.now();
    report.outcome = report.urgent
      ? 'Reviewed by the safety team. The suspension stands while we work with the organisation.'
      : 'Reviewed by the safety team. Logged against the organisation\'s record; we\'ll act on any pattern.';
    const audienceKind = actor.by === 'org_user' ? 'org_user' : actor.by;
    notify({ kind: audienceKind, id: actor.byId }, 'report_resolved', `Your report was reviewed: ${report.outcome}`, report.id);
  }, 45_000);
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
app.get('/orgs', (_req, res) => {
  res.json(db.orgs.map((o) => ({
    id: o.id, name: o.name, type: o.type, plan: o.plan, trustedPartner: o.trustedPartner,
    verified: o.verified, safeguardingCertified: safeguardingCertified(o),
  })));
});

app.post('/auth/org/login', (req, res) => {
  const { orgId, scoutName, role } = req.body || {};
  const org = db.orgs.find((o) => o.id === orgId);
  if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
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
  res.json({ userId: user.id, role: user.role, org: { ...org, safeguardingCertified: safeguardingCertified(org) } });
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

  // Academy+ is a boosted cohort: opted-in players surface first.
  list.sort((a, b) => (b.academyPlus ? 1 : 0) - (a.academyPlus ? 1 : 0) || b.trustScore - a.trustScore);
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
  const { proposedDate, venue, notes } = req.body || {};
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
    trialDetails: type === 'trial' ? { proposedDate: proposedDate || null, venue: venue || null, notes: notes || '' } : null,
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
  }
  items.sort((a, b) => b.ts - a.ts);
  res.json(items.slice(0, 40));
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
  });
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
  const { accept } = req.body || {};
  request.status = accept ? 'accepted' : 'declined';
  request.respondedAt = Date.now();

  if (accept) {
    // Only now does a contact channel exist.
    const channel = openChannel(request);
    request.contactChannel = channel.id;
    ledgerAppend({ type: `${request.type}_accepted`, playerId: req.player.id, orgId: request.orgId, orgName: request.orgName, userId: request.userId, scoutName: request.scoutName });
    if (request.type === 'trial') {
      const details = request.trialDetails ?? {};
      db.trials.push({
        id: nextId('trial'),
        requestId: request.id,
        playerId: req.player.id,
        playerName: req.player.name,
        orgId: request.orgId,
        orgName: request.orgName,
        scoutName: request.scoutName,
        acceptedAt: Date.now(),
        proposedDate: details.proposedDate ?? null,
        venue: details.venue ?? null,
        notes: details.notes ?? '',
        reportDueAt: (details.proposedDate ? new Date(details.proposedDate).getTime() : Date.now()) + 7 * 24 * 3600 * 1000,
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
    db.mediaBlobs[item.id] = { dataUrl };
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
  req.player.stats = { appearances: 0, goals: 0, assists: 0, ...req.player.stats, ...updates };
  recordActivity(req.player);
  broadcast('players', { playerId: req.player.id });
  res.json({ stats: req.player.stats });
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

// Serve uploaded media (any authenticated party with profile access could
// reach this in production; prototype serves by id).
app.get('/media/:id', (req, res) => {
  const blob = db.mediaBlobs[req.params.id];
  if (!blob) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(blob.dataUrl);
  if (!match) return res.status(500).json({ error: 'BAD_STORED_MEDIA' });
  const mime = match[1] || 'application/octet-stream';
  const body = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
  res.set('Content-Type', mime).send(body);
});

// ------------------------------------------------------------------- start
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: err.message });
});

app.listen(PORT, () => {
  console.log(`scoutbox-server listening on :${PORT} — ${db.players.length} players, ${db.orgs.length} orgs seeded`);
});
