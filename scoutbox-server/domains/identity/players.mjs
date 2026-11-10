// Under-18 profiles are owned by a verified guardian and created from the guardian's account (children.mjs); the
// sign-up refuses a minor.
import express from 'express';
import { parseDobStrict } from '../../temporal.mjs';
import { adultAgeFor, ageOn, isAdult, computeTrustScore, trustBreakdown, trustTier, computeStreak, weeklyGoal, nextActions } from '../../domain.mjs';
import { IDENTITY_LIMITS, PLAYER_POSITIONS, PLAYER_FEET } from '../../repositories/identity.mjs';
import { hashPassword, verifyPassword } from '../../adapters.mjs';
import { rateLimitedBody } from '../platform/rateLimit.mjs';
import { pathwayFor, programmeProgress } from '../../grassrootsJourney.mjs';
import { playerSelfView } from '../../views/playerViews.mjs';

/**
 * A date of birth that cannot be read is refused rather than stored: it would fail closed as "age unknown", but the
 * account's age could then never be established. Returns true when refused.
 */
export function profileRefused(res, body) {
  const bad = (status, payload) => { res.status(status).json(payload); return true; };
  const field = (f, message) => bad(400, { error: 'FIELD_INVALID', field: f, message });
  const absent = (v) => v === undefined || v === null || v === '';
  if (!body.name || !body.dob) return bad(400, { error: 'NAME_AND_DOB_REQUIRED' });
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > IDENTITY_LIMITS.name) return field('name', `name must be text of 1 to ${IDENTITY_LIMITS.name} characters.`);
  if (body.country !== undefined && !(typeof body.country === 'string' && body.country.length >= 1 && body.country.length <= IDENTITY_LIMITS.country)) return field('country', `country must be text of 1 to ${IDENTITY_LIMITS.country} characters.`);
  if (!absent(body.city) && !(typeof body.city === 'string' && body.city.length <= IDENTITY_LIMITS.city)) return field('city', `city must be text of at most ${IDENTITY_LIMITS.city} characters.`);
  if (!absent(body.position) && !PLAYER_POSITIONS.includes(body.position)) return field('position', `position must be one of ${PLAYER_POSITIONS.join(', ')}.`);
  if (!absent(body.foot) && !PLAYER_FEET.includes(body.foot)) return field('foot', `foot must be one of ${PLAYER_FEET.join(', ')}.`);
  for (const f of ['heightCm', 'weightKg']) {
    const [lo, hi] = IDENTITY_LIMITS[f];
    if (!absent(body[f]) && !(Number.isSafeInteger(body[f]) && body[f] >= lo && body[f] <= hi)) return field(f, `${f} must be a whole number from ${lo} to ${hi}.`);
  }
  for (const [f, lim] of [['lat', 90], ['lng', 180]]) if (!absent(body[f]) && !(typeof body[f] === 'number' && Number.isFinite(body[f]) && Math.abs(body[f]) <= lim)) return field(f, `${f} must be a number from -${lim} to ${lim}.`);
  if (!parseDobStrict(body.dob, Date.now()).ok) return bad(400, { error: 'DOB_INVALID', message: 'Enter a date of birth as YYYY-MM-DD.' });
  return false;
}

const optional = (v) => (v === undefined || v === null || v === '' ? null : v);

/** Without coordinates the player is not visible to grassroots clubs: the radius rule fails closed. */
export function newPlayerRecord(body, id) {
  return {
    id, name: body.name, dob: body.dob, country: body.country ?? 'GB',
    position: optional(body.position), foot: optional(body.foot), heightCm: optional(body.heightCm), weightKg: optional(body.weightKg),
    createdAt: Date.now(),
    location: typeof body.lat === 'number' && typeof body.lng === 'number' ? { lat: body.lat, lng: body.lng } : null,
  };
}

/**
 * `guardianManagedOnly` refuses what a parent manages for a child account (messages, notifications, club
 * interaction). The child keeps football activity (uploads, stats, drills, attendance).
 */
export function createPlayerSession({ app, findPlayer, sessionFor }) {
  function playerAuth(req, res, next) {
    const session = sessionFor(req);
    const p = session?.kind === 'player' ? findPlayer(session.refId) : null;
    if (!p) return res.status(401).json({ error: 'PLAYER_AUTH_REQUIRED', message: 'Log in again — this session is no longer valid.' });
    req.player = p;
    req.playerIsMinor = !isAdult(p);
    next();
  }
  function guardianManagedOnly(req, res) {
    if (!req.playerIsMinor) return false;
    res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'This setting is managed by your parent or guardian.' });
    return true;
  }
  const playerRouter = express.Router();
  app.use('/player', playerAuth, playerRouter);
  return { playerRouter, guardianManagedOnly };
}

/** Seed identities without a password are demo logins, open only while dev logins are enabled. */
export function registerPlayerAccount({
  app, playerRouter, players, guardians, findPlayer, codes, unit, seam, nextId, rateLimit, broadcast, notify, ledgerAppend,
  createSession, loginLockedOut, noteLoginFailure, devLogins, devLoginRefused, checkSavedSearches, publishedVouchesFor, vouchesFor,
}) {
  if (typeof players?.ageUp !== 'function' || typeof checkSavedSearches !== 'function') throw new TypeError('registerPlayerAccount needs the players repository and the saved-search check');

  app.post('/auth/player/signup', (req, res) => {
    const body = req.body || {};
    if (profileRefused(res, body)) return;
    if (!body.password || String(body.password).length < 8) {
      return res.status(400).json({ error: 'PASSWORD_REQUIRED', message: 'Pick a password of at least 8 characters — your profile is yours alone.' });
    }
    const required = adultAgeFor(body.country ?? 'GB');
    if (ageOn(body.dob) < required) {
      return res.status(403).json({
        error: 'GUARDIAN_REQUIRED',
        message: `Under-${required} profiles are owned by a parent or guardian. A guardian must verify their ID, accept the safeguarding disclaimer, and create the profile from their own account.`,
      });
    }
    const record = { ...newPlayerRecord(body, nextId('pl')), city: optional(body.city), passwordHash: hashPassword(body.password) };
    let created; let token;
    try {
      unit(() => {
        created = players.create(record);
        checkSavedSearches(created);
        token = createSession('player', created.id);
        broadcast('players');
      });
    } catch (e) {
      if (e?.code === 'PLAYER_RECORD_INVALID') return res.status(400).json({ error: 'PLAYER_INVALID', message: String(e.message) });
      throw e;
    }
    res.status(201).json({ playerId: created.id, player: playerSelfView(created), token });
  });

  app.post('/auth/player/login', (req, res) => {
    // Checked before the lookup, so an unknown id and a real one are refused alike once the budget is gone.
    if (loginLockedOut(res, `player:${req.body?.playerId}`)) return;
    const p = findPlayer(req.body?.playerId);
    if (!p) { noteLoginFailure(`player:${req.body?.playerId}`); return res.status(404).json({ error: 'PLAYER_NOT_FOUND' }); }
    const hash = players.passwordHashOf(p.id);
    if (hash) {
      const check = verifyPassword(req.body?.password ?? '', hash);
      if (!check) { noteLoginFailure(`player:${p.id}`); return res.status(401).json({ error: 'BAD_PASSWORD', message: 'This profile is password-protected.' }); }
      if (check === 'upgrade') players.setPasswordHash(p.id, hashPassword(req.body.password));
    } else if (!devLogins) {
      return devLoginRefused(res);
    }
    res.json({ playerId: p.id, name: p.name, token: createSession('player', p.id) });
  });

  app.post('/auth/player/pair', (req, res) => {
    const { code } = req.body || {};
    // A wrong code is charged per client address, on top of the /auth limiter.
    const source = req.ip ?? req.socket?.remoteAddress ?? '?';
    if (rateLimit.peek('pairing_attempt', source).remaining === 0) return res.status(429).json(rateLimitedBody('pairing_attempt'));
    const live = codes.peekPairingCode(code);
    const p = live ? findPlayer(live.playerId) : null;
    if (!live || !p) {
      if (live && !p) codes.revokePairingCodesFor(live.playerId);
      rateLimit.limited('pairing_attempt', source);
      return res.status(404).json({ error: 'CODE_INVALID', message: 'That pairing code is wrong or expired — ask your parent/guardian for a fresh one.' });
    }
    // One unit, so a failure anywhere, COMMIT included, keeps the code live and creates no session.
    let token = null;
    unit(() => {
      const consumed = codes.consumePairingCode(code);
      if (!consumed || consumed.playerId !== p.id) throw new Error('pairing: the code changed between the check and the exchange');
      seam('pairing.after_consume');
      token = createSession('player', p.id);
    });
    res.json({ playerId: p.id, name: p.name, token });
  });

  playerRouter.get('/me', (req, res) => {
    const p = req.player;
    const score = computeTrustScore(p);
    res.json({
      ...playerSelfView(p),
      age: ageOn(p.dob),
      trustScore: score,
      trust: trustBreakdown(p),
      tier: trustTier(score),
      streak: computeStreak(p.activityLog),
      weeklyGoal: weeklyGoal(p.activityLog),
      nextActions: nextActions(p),
      agingUp: isAdult(p) && p.guardianId ? { eligible: true } : null,
      pathway: pathwayFor(p, { vouchCount: publishedVouchesFor(p.id).length }), // null for pro-level players
      programme: programmeProgress(p),
      vouches: vouchesFor(p.id),
    });
  });

  // The day a guardian-owned player turns 18, ownership moves to them with their consent.
  playerRouter.post('/aging-up/complete', (req, res) => {
    if (!isAdult(req.player)) return res.status(403).json({ error: 'STILL_A_MINOR', message: 'The transition unlocks on your 18th birthday (age of majority in your country).' });
    if (!req.player.guardianId) return res.status(400).json({ error: 'ALREADY_OWNED', message: 'You already own this account.' });
    const guardian = guardians.byId(req.player.guardianId);
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
}
