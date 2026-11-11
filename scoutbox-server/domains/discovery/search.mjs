// Club search: the Discover directory, a player's profile with "more like this", internal scouting notes, saves and
// shortlists. A player who blocked the organisation reads as absent on every one of these routes.
import { visibleToOrg, similarityScore } from '../../domain.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { filled, presentOrRefuse } from '../platform/schemas.mjs';
import { discoveryInput } from './schemas.mjs';
import { ARCHETYPES } from '../../catalogue.mjs';

const AGE_GROUPS = {
  u16: { ageBelow: 16 },
  u18: { ageBelow: 18 },
  '18-21': { ageAtLeast: 18, ageBelow: 22 },
  senior: { ageAtLeast: 22 },
};

const noteView = (n) => ({
  id: n.id,
  orgId: n.orgId,
  playerId: n.playerId,
  userId: n.userId,
  scoutName: n.scoutName,
  text: n.text,
  ts: n.ts,
});

export function registerPlayerSearch({
  orgRouter,
  players,
  safetyAudit,
  findPlayer,
  isBlocked,
  ledgerAppend,
  broadcast,
  nextId,
  playerViewForOrg,
}) {
  /** Best first; a tie keeps creation order. Ranked over light rows so only the winners are decoded. */
  function mostSimilar(base, org, k) {
    const best = [];
    players.scanLight({ visibleTo: org, exceptId: base.id }, (c) => {
      const score = similarityScore(base, c);
      if (best.length === k && score <= best[k - 1].score) return;
      let i = best.length;
      while (i > 0 && best[i - 1].score < score) i -= 1;
      best.splice(i, 0, { c, score });
      if (best.length > k) best.pop();
    });
    return best;
  }

  orgRouter.get('/players', (req, res) => {
    // A filter sent twice arrives as a list, and is refused.
    const query = discoveryInput(res, 'directoryQuery', req.query, 'query');
    if (!query) return;
    const { q, position, academyPlus, availability, country, ageGroup, newDays } = query;
    let page;
    try {
      page = readPage(query, players.directoryCursorShape(req.org));
    } catch (e) {
      return sendPageError(res, e);
    }
    // Visibility, filters and order are the query's, so the page is exact; the view still applies the rule.
    //   Pro / agency: Academy+ first (an opted-in cohort), then profile completeness (not ability).
    //   Grassroots: First Team Seekers first (need-based, not purchasable), then the nearest ground (to 0.1 km, as
    //   shown), then completeness.
    const result = players.directoryPage(
      req.org,
      {
        position: position || undefined,
        availability: availability || undefined,
        country: country || undefined,
        academyPlus: academyPlus === 'true' || undefined,
        ...(AGE_GROUPS[ageGroup] ?? {}),
        ...(newDays ? { createdSince: Date.now() - Number(newDays) * 24 * 3600 * 1000 } : {}),
        text: q || undefined,
      },
      page,
    );
    res.set(
      'X-ScoutBox-Ordering',
      req.org.level === 'grassroots'
        ? 'first_team_seeker,distance,profile_completeness,player_id'
        : 'academy_plus,profile_completeness,player_id',
    );
    res.json({
      items: result.items.map((p) => playerViewForOrg(p, req.org)).filter(Boolean),
      nextCursor: result.nextCursor,
    });
  });

  orgRouter.get('/players/:id', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!visibleToOrg(p, req.org)) {
      // Agencies never see minors; unverified clubs don't either.
      const code = req.org.type === 'agency' ? 'UNDER_18_WALL' : 'VERIFIED_CLUBS_ONLY';
      return res.status(403).json({
        error: code,
        message:
          code === 'UNDER_18_WALL'
            ? 'Agency accounts cannot view minors.'
            : 'Under-18 profiles are visible to verified clubs only. Complete club verification to continue.',
      });
    }
    if (isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    ledgerAppend({
      type: 'view',
      playerId: p.id,
      orgId: req.org.id,
      orgName: req.org.name,
      userId: req.orgUser.id,
      scoutName: req.orgUser.name,
    });
    const view = playerViewForOrg(p, req.org);
    const similar = mostSimilar(p, req.org, 3).map(({ c, score }) => ({
      playerId: c.id,
      name: c.name,
      position: c.position,
      score,
    }));
    const archetypes = ARCHETYPES.map((a) => ({ archetypeId: a.id, label: a.label, score: similarityScore(p, a) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    const orgNotes = safetyAudit.orgNotes.forOrgPlayer(req.org.id, p.id).map(noteView);
    res.json({
      ...view,
      orgNotes,
      similarPlayers: { note: 'Statistical similarity — a lead, not a verdict.', players: similar, archetypes },
    });
  });

  // Scouting notes are shared inside the organisation only, not with the player or any other organisation.
  orgRouter.post('/players/:id/notes', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || !visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id))
      return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const body = discoveryInput(res, 'note', req.body);
    if (!body) return;
    const text = filled(body.text);
    if (!presentOrRefuse(res, text, 'text')) return;
    const note = {
      id: nextId('note'),
      orgId: req.org.id,
      playerId: p.id,
      userId: req.orgUser.id,
      scoutName: req.orgUser.name,
      text,
      ts: Date.now(),
    };
    const stored = safetyAudit.orgNotes.add(note);
    broadcast('players', { playerId: p.id });
    res.status(201).json(noteView(stored));
  });

  orgRouter.get('/players/:id/morelike', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || !visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id))
      return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const top = mostSimilar(p, req.org, 10);
    const full = new Map(players.byIds(top.map(({ c }) => c.id)).map((c) => [c.id, c]));
    const ranked = top
      .map(({ c, score }) => {
        const view = full.has(c.id) ? playerViewForOrg(full.get(c.id), req.org) : null;
        return view ? { ...view, similarity: score } : null;
      })
      .filter(Boolean);
    res.json({ base: { id: p.id, name: p.name, position: p.position }, players: ranked });
  });

  for (const action of ['save', 'shortlist']) {
    orgRouter.post(`/players/:id/${action}`, (req, res) => {
      const p = findPlayer(req.params.id);
      if (!p || isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
      if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
      if (!discoveryInput(res, 'none', req.body)) return;
      const row = ledgerAppend({
        type: action,
        playerId: p.id,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
      res.status(201).json({ ok: true, ledgerId: row.id });
    });
  }

  orgRouter.get('/shortlist', (req, res) => {
    const ids = safetyAudit.ledger.playersListedBy(req.org.id);
    // A player who has deleted their account is absent; the ledger row stays, id only.
    res.json(
      ids
        .map((id) => findPlayer(id))
        .filter(Boolean)
        .map((p) => playerViewForOrg(p, req.org))
        .filter(Boolean),
    );
  });
}
