// Grassroots club operations. The player's side is grassroots.mjs.
import { filled } from '../platform/schemas.mjs';
import { OPEN_DAY_OUTCOMES, developmentInput } from './schemas.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { isAdult, visibleToOrg, computeTrustScore, haversineKm, GRASSROOTS_RADIUS_KM } from '../../domain.mjs';
import { GRASSROOTS_LIMITS as GL, boxAround } from '../../repositories/grassroots.mjs';
import { TRANSITION_LIMITS } from '../../repositories/transitionsVouches.mjs';
import { grassrootsOrgOnly } from './guards.mjs';

/** Answers 403 and returns true for a club not on ScoutBox Grassroots. */

const POSITION_GROUPS = {
  GK: ['GK'],
  DEF: ['CB', 'RB', 'LB', 'RWB', 'LWB'],
  MID: ['CDM', 'CM', 'CAM'],
  ATT: ['ST', 'CF', 'RW', 'LW'],
};
const registrationView = (r) => ({
  id: r.id,
  playerId: r.playerId,
  playerName: r.playerName,
  byGuardian: r.byGuardian,
  ...(r.guardianId ? { guardianId: r.guardianId } : {}),
  ts: r.ts,
  outcome: r.outcome,
  outcomeNote: r.outcomeNote,
  outcomeAt: r.outcomeAt,
});

/** Returns `pathwayRecord(org)` and `openTrialView(t)`, which the directory and the player's journey also use. */
export function registerGrassrootsClub({
  orgRouter,
  players,
  playerRecord,
  grassroots,
  clubSetup,
  scoutingActs,
  coachReferences,
  signings,
  findPlayer,
  findOrg,
  unit,
  seam,
  nextId,
  ledgerAppend,
  notify,
  broadcast,
  moderateOrRefuse,
  playerViewForOrg,
  recordActivity,
  canonicalContractFor,
  issueRecruitmentRequest,
}) {
  if (typeof issueRecruitmentRequest !== 'function' || typeof canonicalContractFor !== 'function')
    throw new TypeError('registerGrassrootsClub needs the request writer and the canonical contract lookup');
  // A club's name is read live, not copied when it posted.
  const orgNameOf = (orgId) => findOrg(orgId)?.name ?? null;
  const openTrialView = (t) => ({
    id: t.id,
    orgId: t.orgId,
    orgName: orgNameOf(t.orgId),
    title: t.title,
    date: t.date,
    venue: t.venue,
    ageGroup: t.ageGroup,
    positions: [...t.positions],
    notes: t.notes,
    createdByUserId: t.createdByUserId,
    createdAt: t.createdAt,
  });

  // ------------------------------------------------------------------ open trial days
  orgRouter.post('/open-trials', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const body = developmentInput(res, 'openTrial', req.body);
    if (!body) return;
    // No ghosting: unanswered past registrants block the next posting, as unfiled trial reports block new trials.
    const today = new Date().toISOString().slice(0, 10);
    const unresolved = grassroots.openTrials.unresolvedBefore(req.org.id, today);
    if (unresolved > 0) {
      return res.status(409).json({
        error: 'OUTCOMES_OUTSTANDING',
        message: `${unresolved} player(s) from your past open day(s) are still waiting for an answer. Resolve them (invite or a kind no) before posting the next one.`,
      });
    }
    // Dates are compared as strings, so the schema refuses anything but a calendar day: other text would stay
    // "upcoming" for ever and escape the rule above.
    const { title, date, venue, ageGroup, positions, notes } = body;
    if (!filled(title) || !date || !filled(venue)) return res.status(400).json({ error: 'TITLE_DATE_VENUE_REQUIRED' });
    const wanted = [...new Set((positions ?? []).map((x) => x.trim()))];
    if (notes && !moderateOrRefuse(res, notes, { kind: 'open_trial_notes', orgId: req.org.id })) return;
    const trial = unit(() => {
      const t = grassroots.openTrials.create({
        id: nextId('open'),
        orgId: req.org.id,
        title: title.trim(),
        date,
        venue: venue.trim(),
        ageGroup: ageGroup?.trim() || 'open',
        positions: wanted,
        notes: notes || '',
        createdByUserId: req.orgUser.id,
        createdAt: Date.now(),
        deletedAt: null,
        registrations: [],
      });
      ledgerAppend({
        type: 'open_trial_posted',
        playerId: null,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
      return t;
    });
    broadcast('openTrials');
    res.status(201).json({ openTrial: { ...openTrialView(trial), registrations: [] } });
  });

  orgRouter.get('/open-trials', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const query = developmentInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = grassroots.openTrials.pageForOrg(req.org.id, page);
    // A club that cannot see a minor never received their registration in the first place.
    res.json({
      items: items.map((t) => ({
        ...openTrialView(t),
        registrations: t.registrations.map((r) => {
          const p = findPlayer(r.playerId);
          const view = p ? playerViewForOrg(p, req.org) : null;
          return {
            ...registrationView(r),
            age: view?.age ?? null,
            position: view?.position ?? null,
            trustScore: view?.trustScore ?? null,
            guardianManaged: !!view?.guardianManaged,
          };
        }),
      })),
      nextCursor,
    });
  });

  // A soft delete, so a coverage assignment naming it keeps its key.
  orgRouter.delete('/open-trials/:id', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    if (!grassroots.openTrials.remove(req.org.id, req.params.id, Date.now()))
      return res.status(404).json({ error: 'OPEN_TRIAL_NOT_FOUND' });
    broadcast('openTrials');
    res.json({ deleted: true });
  });

  // Codes only: the players' opportunity radar matches them against the player's position.
  orgRouter.post('/looking-for', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const body = developmentInput(res, 'lookingFor', req.body);
    if (!body) return;
    const { positions } = body;
    const lookingFor = scoutingActs.setLookingFor(req.org.id, [...new Set(positions)]);
    broadcast('orgs');
    res.json({ lookingFor });
  });

  orgRouter.post('/open-trials/:id/registrations/:regId/outcome', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const body = developmentInput(res, 'openDayOutcome', req.body);
    if (!body) return;
    const trial = grassroots.openTrials.forOrgById(req.org.id, req.params.id);
    const reg = trial?.registrations.find((r) => r.id === req.params.regId);
    if (!trial || !reg) return res.status(404).json({ error: 'REGISTRATION_NOT_FOUND' });
    if (reg.outcome) return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { outcome, note } = body;
    if (!outcome)
      return res
        .status(400)
        .json({ error: 'OUTCOME_INVALID', field: 'outcome', problem: 'required', allowed: OPEN_DAY_OUTCOMES });
    if (note && !moderateOrRefuse(res, note, { kind: 'open_day_outcome', orgId: req.org.id })) return;
    const outcomeNote = filled(note);
    const p = findPlayer(reg.playerId);
    const answered = unit(() => {
      const r = grassroots.openTrials.resolve(trial.id, reg.id, { outcome, note: outcomeNote, at: Date.now() });
      if (p && visibleToOrg(p, req.org)) {
        if (outcome === 'invite_trial') {
          // The shared request writer routes a minor's request to the guardian. Several pending invitations per
          // player are allowed (product decision).
          issueRecruitmentRequest({
            org: req.org,
            orgUser: req.orgUser,
            player: p,
            type: 'trial',
            message: outcomeNote || `We liked what we saw at "${trial.title}" — come for a proper trial.`,
            trialDetails: {
              proposedDate: null,
              altSlots: [],
              venue: trial.venue,
              notes: `Follow-up from open day "${trial.title}".`,
            },
            notice: {
              kind: 'open_trial',
              toGuardian: `Good news: ${req.org.name} would like to invite ${p.name} for a trial after the open day.`,
              toPlayer: isAdult(p)
                ? `${req.org.name} liked what they saw at "${trial.title}" — trial invitation in your inbox.`
                : `${req.org.name} liked what they saw at the open day — they've contacted your parent/guardian about a trial.`,
            },
          });
        } else {
          const kindNo =
            outcomeNote || 'Thanks for coming — not this time, but keep playing and keep logging your football.';
          if (!isAdult(p) && p.guardianId) {
            notify(
              { kind: 'guardian', id: p.guardianId },
              'open_trial',
              `${req.org.name} on ${p.name}'s open day: ${kindNo}`,
              trial.id,
            );
          }
          notify({ kind: 'player', id: p.id }, 'open_trial', `${req.org.name}: ${kindNo}`, trial.id);
        }
      }
      return r;
    });
    broadcast('openTrials');
    res.json({ registration: registrationView(answered) });
  });

  // ------------------------------------------------------------------ squad and match days
  // The Pro squad planner's shadow list is not part of the squad.
  function squadView(org) {
    const entries = clubSetup.squad.forOrg(org.id).map((e) => {
      const p = e.playerId ? findPlayer(e.playerId) : null;
      return {
        id: e.id,
        name: e.name,
        position: e.position,
        playerId: e.playerId,
        source: e.source,
        ...(e.approvedBy ? { approvedBy: e.approvedBy } : {}),
        addedAt: e.addedAt,
        onPlatform: !!p,
        trustScore: p ? computeTrustScore(p) : null,
      };
    });
    const coverage = Object.fromEntries(
      Object.entries(POSITION_GROUPS).map(([group, positions]) => [
        group,
        entries.filter((e) => positions.includes(e.position)).length,
      ]),
    );
    const gaps = Object.entries(coverage)
      .filter(([, n]) => n < 2)
      .map(([g]) => g);
    const suggestedLookingFor = gaps.flatMap((g) => POSITION_GROUPS[g].slice(0, 2)).slice(0, 5);
    return { entries, coverage, gaps, suggestedLookingFor };
  }

  orgRouter.get('/squad', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    res.json(squadView(req.org));
  });

  orgRouter.post('/squad', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const body = developmentInput(res, 'squad', req.body);
    if (!body) return;
    const { name, position, playerId } = body;
    if (!filled(name)) return res.status(400).json({ error: 'NAME_REQUIRED', field: 'name', problem: 'required' });
    if (playerId) {
      const p = findPlayer(playerId);
      if (!p || !visibleToOrg(p, req.org)) return res.status(403).json({ error: 'PLAYER_NOT_VISIBLE' });
      if (clubSetup.squad.has(req.org.id, playerId)) return res.status(409).json({ error: 'ALREADY_ON_SQUAD' });
    }
    scoutingActs.addToSquad({
      id: nextId('sq'),
      orgId: req.org.id,
      name: name.trim(),
      position: position || null,
      playerId: playerId || null,
      source: 'manual',
      addedAt: Date.now(),
    });
    res.status(201).json(squadView(req.org));
  });

  orgRouter.post('/squad/:entryId/release', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const body = developmentInput(res, 'release', req.body);
    if (!body) return;
    const entry = clubSetup.squad.byId(req.params.entryId);
    if (!entry || entry.orgId !== req.org.id) return res.status(404).json({ error: 'SQUAD_ENTRY_NOT_FOUND' });
    const referenceText = filled(body.referenceText) ?? '';
    if (referenceText && !moderateOrRefuse(res, referenceText, { kind: 'release_reference', orgId: req.org.id }))
      return;
    unit(() => {
      scoutingActs.removeFromSquad(entry.id);
      const p = entry.playerId ? findPlayer(entry.playerId) : null;
      if (p) {
        // A contract another club completed in ScoutBox still stands after this release.
        const other = canonicalContractFor(p.id, Date.now(), { exceptOrgId: req.org.id });
        if (!other) playerRecord.setAvailability(p.id, { availability: 'available_now', contractStatus: 'free_agent' });
        seam('squad.release.after_row');
        if (referenceText) {
          coachReferences.add({
            id: nextId('vch'),
            playerId: p.id,
            playerName: p.name?.slice(0, TRANSITION_LIMITS.name) ?? null,
            coachName: req.orgUser.name.slice(0, TRANSITION_LIMITS.coachName),
            coachEmail: null,
            role: `${req.orgUser.role || 'Manager'}, ${req.org.name}`.slice(0, TRANSITION_LIMITS.role),
            status: 'published',
            codeHash: null,
            text: referenceText,
            seasons: null,
            ts: Date.now(),
            publishedAt: Date.now(),
            conflictOfInterest: null,
            withdrawn: null,
          });
        }
        ledgerAppend({
          type: 'released_by_club',
          playerId: p.id,
          orgId: req.org.id,
          orgName: req.org.name,
          userId: req.orgUser.id,
          scoutName: req.orgUser.name,
        });
        notify(
          { kind: 'player', id: p.id },
          'released',
          `${req.org.name} has released you${referenceText ? ' — with a reference now on your profile' : ''}. You're marked available to every local club; the First Team Seeker flag is yours to switch on.`,
          p.id,
        );
        if (p.guardianId)
          notify(
            { kind: 'guardian', id: p.guardianId },
            'released',
            `${req.org.name} released ${p.name}${referenceText ? ' with a reference' : ''}. Their profile is marked available again.`,
            p.id,
          );
        broadcast('players', { playerId: p.id });
      }
    });
    res.json(squadView(req.org));
  });

  orgRouter.post('/matchday', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const body = developmentInput(res, 'matchday', req.body);
    if (!body) return;
    const { fixture, venue, date, result } = body;
    if (!filled(fixture) || !date) return res.status(400).json({ error: 'FIXTURE_AND_DATE_REQUIRED' });
    const ids = body.playerIds ?? [];
    const onSquad = new Set(clubSetup.squad.playerIds(req.org.id));
    const credited = [];
    const fixtureText = fixture.trim();
    unit(() => {
      for (const pid of new Set(ids)) {
        if (!onSquad.has(pid)) continue;
        const p = findPlayer(pid);
        if (!p || !visibleToOrg(p, req.org)) continue;
        playerRecord.recordAttendance(p.id, {
          id: nextId('att'),
          fixture: fixtureText,
          venue: venue?.trim() || req.org.location?.city || '',
          date,
          gps: req.org.location ? { lat: req.org.location.lat, lng: req.org.location.lng } : null,
          verified: true,
          corroboratedBy: req.org.name, // the coach's counter-signature
        });
        recordActivity(p);
        notify(
          { kind: 'player', id: p.id },
          'matchday',
          `📍 ${req.org.name} logged your appearance in "${fixtureText}" — verified, coach-signed attendance on your profile.`,
          p.id,
        );
        credited.push(p.id);
        broadcast('players', { playerId: p.id });
      }
      grassroots.matchdays.create({
        id: nextId('md'),
        orgId: req.org.id,
        fixture: fixtureText,
        venue: venue?.trim() ?? '',
        date,
        result: result?.trim() || null,
        playerIds: credited,
        loggedByUserId: req.orgUser.id,
        ts: Date.now(),
      });
      ledgerAppend({
        type: 'matchday_logged',
        playerId: null,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
    });
    res.status(201).json({ credited: credited.length, matchdays: grassroots.matchdays.countForOrg(req.org.id) });
  });

  orgRouter.get('/matchdays', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const query = developmentInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = grassroots.matchdays.pageForOrg(req.org.id, page);
    res.json({
      items: items.map((m) => ({
        id: m.id,
        orgId: m.orgId,
        fixture: m.fixture,
        venue: m.venue,
        date: m.date,
        result: m.result,
        playerIds: [...m.playerIds],
        loggedByUserId: m.loggedByUserId,
        ts: m.ts,
      })),
      nextCursor,
    });
  });

  // ------------------------------------------------------------------ pathway record
  // Players the club was involved with who later signed for a non-grassroots club.
  function pathwayRecord(org) {
    const orgSignings = signings.forOrg(org.id);
    const registrants = grassroots.openTrials.registrantsOf(org.id);
    const involvedIds = new Set([
      ...orgSignings.map((sg) => sg.playerId),
      ...clubSetup.squad.playerIds(org.id),
      ...registrants.map((r) => r.playerId),
    ]);
    const firstInvolvement = (pid) =>
      Math.min(
        ...orgSignings.filter((sg) => sg.playerId === pid).map((sg) => sg.ts),
        ...registrants.filter((r) => r.playerId === pid).map((r) => r.ts),
      );
    const progressed = [...involvedIds].filter((pid) => {
      const upward = signings
        .forPlayer(pid)
        .find((sg) => sg.orgId !== org.id && (findOrg(sg.orgId)?.level ?? '') !== 'grassroots');
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

  // ------------------------------------------------------------------ friendlies board
  const friendlyView = (f, viewer) => {
    const other = findOrg(f.orgId);
    const mine = f.orgId === viewer.id;
    return {
      id: f.id,
      orgId: f.orgId,
      orgName: other?.name ?? null,
      postedByUserId: f.postedByUserId,
      ageGroup: f.ageGroup,
      date: f.date,
      venue: f.venue,
      notes: f.notes,
      status: 'open',
      createdAt: f.createdAt,
      mine,
      distanceKm:
        mine || !other?.location || !viewer.location
          ? 0
          : Math.round(haversineKm(other.location, viewer.location) * 10) / 10,
      // The responders' messages are the poster's alone.
      responses: f.responses.map((r) => ({
        orgId: r.orgId,
        orgName: orgNameOf(r.orgId),
        message: mine ? r.message : '',
        respondedByUserId: r.respondedByUserId,
        ts: r.ts,
      })),
    };
  };

  orgRouter.post('/friendlies', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const body = developmentInput(res, 'friendly', req.body);
    if (!body) return;
    const { ageGroup, date, venue, notes } = body;
    if (!date) return res.status(400).json({ error: 'DATE_REQUIRED', field: 'date', problem: 'required' });
    if (notes && !moderateOrRefuse(res, notes, { kind: 'friendly_notes', orgId: req.org.id })) return;
    const friendly = grassroots.friendlies.create({
      id: nextId('fr'),
      orgId: req.org.id,
      postedByUserId: req.orgUser.id,
      ageGroup: ageGroup?.trim() || 'open',
      date,
      venue: venue?.trim() || (req.org.location?.city ?? '').slice(0, GL.venue),
      notes: notes || '',
      responses: [],
      createdAt: Date.now(),
    });
    broadcast('friendlies');
    res.status(201).json({ friendly: friendlyView(friendly, req.org) });
  });

  /** The club's own friendlies and those posted within the radius. */
  orgRouter.get('/friendlies', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const query = developmentInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['string', 'string']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const here = req.org.location;
    const box = here ? boxAround(here, GRASSROOTS_RADIUS_KM) : null;
    const near = (f) => {
      const loc = findOrg(f.orgId)?.location;
      return !!loc && haversineKm(loc, here) <= GRASSROOTS_RADIUS_KM;
    };
    const { items, nextCursor } = grassroots.friendlies.boardPage(req.org.id, box, page, near);
    res.json({ items: items.map((f) => friendlyView(f, req.org)), nextCursor });
  });

  orgRouter.post('/friendlies/:id/respond', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const friendly = grassroots.friendlies.byId(req.params.id);
    if (!friendly) return res.status(404).json({ error: 'FRIENDLY_NOT_FOUND' });
    if (friendly.orgId === req.org.id) return res.status(400).json({ error: 'OWN_POST' });
    const body = developmentInput(res, 'friendlyResponse', req.body);
    if (!body) return;
    const { message } = body;
    if (message && !moderateOrRefuse(res, message, { kind: 'friendly_response', orgId: req.org.id })) return;
    if (friendly.responses.some((r) => r.orgId === req.org.id))
      return res.status(409).json({ error: 'ALREADY_RESPONDED' });
    unit(() => {
      grassroots.friendlies.respond(friendly.id, {
        orgId: req.org.id,
        message: filled(message) ?? '',
        respondedByUserId: req.orgUser.id,
        ts: Date.now(),
      });
      notify(
        { kind: 'org_user', id: friendly.postedByUserId },
        'friendly',
        `${req.org.name} is up for your friendly on ${friendly.date}.`,
        friendly.id,
      );
    });
    broadcast('friendlies');
    res.status(201).json({ responded: true });
  });

  return { pathwayRecord, openTrialView };
}
