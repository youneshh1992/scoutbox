import { readPage, sendPageError } from '../platform/paging.mjs';
import { filled } from '../platform/schemas.mjs';
import { rateLimitedBody } from '../platform/rateLimit.mjs';
import { adultAgeFor, ageOn, computeStreak, weeklyGoal } from '../../domain.mjs';
import { guardianChildView } from '../../views/playerViews.mjs';
import { profileOrRefuse, newPlayerRecord } from './players.mjs';
import { identityInput } from './schemas.mjs';

export function ownChild(req, res, findPlayer, id = req.params.id) {
  const child = findPlayer(id);
  if (child && req.guardian.childIds.includes(child.id)) return child;
  res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  return null;
}

export function registerChildren({
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
  requestsFor,
  ledgerPageForPlayers,
  ledgerView,
  viewHelpers,
}) {
  if (typeof players?.setMedicalSharing !== 'function' || typeof checkSavedSearches !== 'function')
    throw new TypeError('registerChildren needs the players repository and the saved-search check');
  const childOf = (req, res, id) => ownChild(req, res, findPlayer, id);

  guardianRouter.get('/children', (req, res) => {
    res.json(
      req.guardian.childIds
        .map((id) => findPlayer(id))
        .filter(Boolean)
        .map((p) => guardianChildView(p, viewHelpers)),
    );
  });

  guardianRouter.post('/children', (req, res) => {
    if (req.guardian.emailVerified === false) {
      return res
        .status(403)
        .json({ error: 'EMAIL_UNVERIFIED', message: 'Verify your email address first — the code is in your inbox.' });
    }
    if (!req.guardian.idVerified) {
      return res
        .status(403)
        .json({ error: 'GUARDIAN_ID_UNVERIFIED', message: 'Verify your identity before onboarding a child.' });
    }
    if (!req.guardian.disclaimerAccepted) {
      return res.status(403).json({
        error: 'DISCLAIMER_REQUIRED',
        message: 'Accept the safeguarding disclaimer before onboarding a child.',
      });
    }
    const body = profileOrRefuse(res, 'child', req.body);
    if (!body) return;
    if (ageOn(body.dob) >= adultAgeFor(body.country ?? 'GB')) {
      return res
        .status(400)
        .json({ error: 'NOT_A_MINOR', message: 'Adults create their own account with player sign-up.' });
    }
    // The guardian's childIds follow from the primary link.
    let child;
    try {
      unit(() => {
        child = players.create({ ...newPlayerRecord(body, nextId('pl')), guardianId: req.guardian.id });
        checkSavedSearches(child);
        broadcast('players');
      });
    } catch (e) {
      if (e?.code === 'PLAYER_RECORD_INVALID')
        return res.status(400).json({ error: 'PLAYER_INVALID', message: String(e.message) });
      throw e;
    }
    res.status(201).json({ playerId: child.id, player: guardianChildView(child, viewHelpers) });
  });

  // A co-guardian passes the gates themselves before they can act.
  guardianRouter.post('/coguardian', (req, res) => {
    const body = identityInput(res, 'coGuardian', req.body);
    if (!body) return;
    const name = filled(body.name);
    const email = filled(body.email);
    if (!name || !email) return res.status(400).json({ error: 'NAME_AND_EMAIL_REQUIRED' });
    if (!email.includes('@'))
      return res.status(400).json({
        error: 'FIELD_INVALID',
        field: 'email',
        problem: 'invalid',
        message: 'email must be an e-mail address.',
      });
    const co = {
      id: nextId('gd'),
      name,
      email,
      idVerified: false,
      disclaimerAccepted: false,
      childIds: [...req.guardian.childIds],
      coGuardianOf: req.guardian.id,
      createdAt: Date.now(),
    };
    try {
      guardians.create(co);
    } catch (e) {
      if (e?.code === 'EMAIL_IN_USE')
        return res
          .status(409)
          .json({ error: 'EMAIL_IN_USE', message: 'A guardian account with this email already exists.' });
      if (e?.code === 'GUARDIAN_RECORD_INVALID')
        return res.status(400).json({ error: 'GUARDIAN_INVALID', message: String(e.message) });
      throw e;
    }
    res.status(201).json({
      guardianId: co.id,
      note: 'The co-guardian must verify their ID and accept the disclaimer before they can act.',
    });
  });

  guardianRouter.post('/children/:id/availability', (req, res) => {
    const child = childOf(req, res);
    if (!child) return;
    const body = identityInput(res, 'childAvailability', req.body);
    if (!body) return;
    const { availability } = body;
    const stored = players.setAvailability(child.id, { availability });
    broadcast('players', { playerId: child.id });
    res.json({ availability: stored.availability });
  });

  guardianRouter.post('/children/:id/medical/share', (req, res) => {
    const child = childOf(req, res);
    if (!child) return;
    const body = identityInput(res, 'medicalShare', req.body);
    if (!body) return;
    const stored = players.setMedicalSharing(child.id, body.shared);
    broadcast('players', { playerId: child.id });
    res.json({ shared: stored.medical.shared });
  });

  guardianRouter.get('/children/:id/insights', (req, res) => {
    const child = childOf(req, res);
    if (!child) return;
    res.json(insightsFor(child.id));
  });

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
          newRequests: requestsFor(c.id).filter((r) => r.createdAt >= week).length,
          activityThisWeek: (c.activityLog ?? []).filter((ts) => ts >= week).length,
        };
      }),
      note: 'Only verified clubs can see your children, and every action above is on the ledger.',
    });
  });

  // Every communication about the children is on the ledger, and the parent can read all of it.
  guardianRouter.get('/log', (req, res) => {
    const query = identityInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const out = ledgerPageForPlayers(req.guardian.childIds, page);
    res.json({ items: out.items.map(ledgerView), nextCursor: out.nextCursor });
  });

  // One live code per child, stored as a hash with a 15-minute lifetime; the plain code exists in this response only.
  guardianRouter.post('/children/:id/pairing-code', (req, res) => {
    const child = childOf(req, res);
    if (!child) return;
    if (!identityInput(res, 'none', req.body)) return;
    if (rateLimit.limited('pairing_code_mint', req.guardian.id))
      return res.status(429).json(rateLimitedBody('pairing_code_mint'));
    const { code, expiresAt } = codes.issuePairingCode(child.id);
    res.status(201).json({ code, expiresAt });
  });
}
