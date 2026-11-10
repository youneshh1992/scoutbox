// The Film Room (a swipe deck of playable clips from players the organisation may see, Verified Clips first), clip
// views and scout tags, the club's home feed and the fixture graph built from verified attendances.
import { ageOn, isAdult, visibleToOrg } from '../../domain.mjs';
import { utcDayOf } from '../../temporal.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';

/** Structured tags, no free text. */
export const SCOUT_TAGS = Object.freeze([
  'first_touch', 'pace', 'positioning', 'work_rate', 'left_foot', 'right_foot',
  'aerial', 'composure', 'vision', 'pressing', 'finishing', 'distribution',
]);

export function registerFilmRoom({ orgRouter, players, recruitment, safetyAudit, findPlayer, isBlocked, unit, ledgerAppend, notify, broadcast, playerViewForOrg }) {
  orgRouter.get('/filmroom', (req, res) => {
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

  function visibleClip(req, res) {
    const p = findPlayer(req.params.pid);
    if (!p || !visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) { res.status(404).json({ error: 'NOT_FOUND' }); return null; }
    const m = p.media.find((x) => x.id === req.params.mid);
    if (!m) { res.status(404).json({ error: 'MEDIA_NOT_FOUND' }); return null; }
    return { p, m };
  }

  orgRouter.post('/players/:pid/media/:mid/view', (req, res) => {
    const found = visibleClip(req, res);
    if (!found) return;
    const { p, m } = found;
    const views = (m.views ?? 0) + 1;
    players.patchItem(p.id, 'media', { id: m.id }, { views });
    broadcast('players', { playerId: p.id });
    res.json({ views });
  });

  // Aggregated anonymously for the player.
  orgRouter.post('/players/:pid/media/:mid/tags', (req, res) => {
    const found = visibleClip(req, res);
    if (!found) return;
    const { p, m } = found;
    const { tags } = req.body || {};
    if (!Array.isArray(tags) || tags.length === 0) return res.status(400).json({ error: 'TAGS_REQUIRED', allowed: SCOUT_TAGS });
    const invalid = tags.filter((t) => !SCOUT_TAGS.includes(t));
    if (invalid.length) return res.status(400).json({ error: 'UNKNOWN_TAGS', invalid, allowed: SCOUT_TAGS });
    const next = { ...(m.tags ?? {}) };
    for (const t of tags) next[t] = (next[t] ?? 0) + 1;
    const stored = unit(() => {
      const row = players.patchItem(p.id, 'media', { id: m.id }, { tags: next });
      ledgerAppend({ type: 'clip_tagged', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
      broadcast('players', { playerId: p.id });
      return row;
    });
    res.json({ tags: stored.tags });
  });

  orgRouter.get('/tags', (_req, res) => res.json(SCOUT_TAGS));

  orgRouter.get('/feed', (req, res) => {
    const FOURTEEN_DAYS = Date.now() - 14 * 24 * 3600 * 1000;
    const items = [];
    const shortlisted = new Set(safetyAudit.ledger.playersListedBy(req.org.id, ['shortlist', 'save']));
    // The newest 40 of each kind; the page is the newest 40 of all.
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
    // A trial whose subject removed their account has no report to file.
    for (const t of recruitment.trials.forOrgStatus(req.org.id, 'awaiting_report').filter((x) => !x.subjectRemovedAt)) {
      const dueAt = Number.isFinite(t.reportDueAt) ? t.reportDueAt : null;
      items.push({ type: 'report_due', ts: dueAt ?? Date.now(), playerId: t.playerId, playerName: t.playerName, trialId: t.id, dueAt });
      if (!t.reminderSent && dueAt !== null && dueAt - Date.now() < 48 * 3600 * 1000) {
        recruitment.trials.markReportReminderSent(t.id);
        const request = recruitment.requests.byId(t.requestId);
        if (request?.userId) notify({ kind: 'org_user', id: request.userId }, 'report_due', `Mandatory trial report for ${t.playerName} is due ${utcDayOf(dueAt)}.`, t.id); // the UTC day, not the server locale
      }
    }
    items.sort((a, b) => b.ts - a.ts);
    res.json(items.slice(0, 40));
  });

  orgRouter.get('/fixtures', (req, res) => {
    let page;
    try { page = readPage(req.query, ['string', 'string']); } catch (e) { return sendPageError(res, e); }
    const { items, nextCursor } = players.fixturePage(req.org, page);
    res.json({
      items: items.map((g) => ({ fixture: g.fixture, venue: g.venue, date: g.date, players: g.players.map((p) => ({ id: p.id, name: p.name, position: p.position, age: ageOn(p.dob), trustScore: p.profileSignal })) })),
      nextCursor,
    });
  });
}
