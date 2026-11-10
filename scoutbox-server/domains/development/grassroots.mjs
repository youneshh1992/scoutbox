// The Grassroots journey, exclusive to amateur and semi-pro players: free training programmes, honest benchmarks
// against the player's cohort, the opportunity radar and local open days, First Team Seekers, coach references and
// the season wrap. Adults act for themselves; for a child, registration, the seeker flag and a reference request are
// the guardian's, from the guardian's account.
import { switchRefused } from '../platform/input.mjs';
import { GRASSROOTS_RADIUS_KM, haversineKm, visibleToOrg } from '../../domain.mjs';
import { PLAYER_POSITIONS } from '../../repositories/identity.mjs';
import { GRASSROOTS_LIMITS as GL, boxAround } from '../../repositories/grassroots.mjs';
import { TRANSITION_LIMITS as VL, vouchCodeHash } from '../../repositories/transitionsVouches.mjs';
import { randomCode } from '../../adapters.mjs';
import { PROGRAMME_TRACKS, trackForPosition, programmeProgress, percentileAmong, inCohort } from '../../grassrootsJourney.mjs';
import { ownChild } from '../identity/children.mjs';
import { DRILLS } from './record.mjs';

const DAY_MS = 24 * 3600 * 1000;

export function registerGrassrootsJourney({
  playerRouter, guardianRouter, players, orgs, grassroots, clubSetup, transitionsVouches, findPlayer, findOrg, unit, seam,
  nextId, broadcast, notify, ledgerAppend, mailer, guardianManagedOnly, recordActivity, publishedVouchesFor, scoutViewsOf,
  pathwayRecord, openTrialView, safeguardingCertified,
}) {
  if (typeof players?.startProgramme !== 'function' || typeof pathwayRecord !== 'function') throw new TypeError('registerGrassrootsJourney needs the players repository and the clubs\' pathway record');

  function grassrootsOnly(req, res) {
    if (req.player.level !== 'pro') return false;
    res.status(403).json({ error: 'GRASSROOTS_ONLY', message: 'This is part of the Grassroots journey — pro-level players have moved past it.' });
    return true;
  }
  /** The guardian's grassroots child named in the path, or null with the refusal sent. */
  function grassrootsChild(req, res) {
    const child = ownChild(req, res, findPlayer);
    if (!child) return null;
    if (child.level === 'pro') { res.status(403).json({ error: 'GRASSROOTS_ONLY' }); return null; }
    return child;
  }

  // ------------------------------------------------------------ training programmes, built from the combine
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
    unit(() => {
      players.startProgramme(req.player.id, track.key, Date.now());
      seam('programme.select.after_row');
      broadcast('players', { playerId: req.player.id });
    });
    res.status(201).json({ current: programmeProgress(players.byId(req.player.id)) });
  });

  playerRouter.post('/programme/sessions/:id/complete', (req, res) => {
    if (grassrootsOnly(req, res)) return;
    if (!req.player.programme) return res.status(409).json({ error: 'NO_PROGRAMME', message: 'Pick a training track first.' });
    const session = PROGRAMME_TRACKS[req.player.programme.track]?.sessions.find((x) => x.id === req.params.id);
    if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    unit(() => {
      players.addItem(req.player.id, 'programme.completed', { sessionId: session.id, ts: Date.now() });
      recordActivity(req.player); // programme work feeds the streak and the weekly goal
      broadcast('players', { playerId: req.player.id });
    });
    res.json({ current: programmeProgress(players.byId(req.player.id)) });
  });

  // Context, never a leaderboard: percentiles among amateur and semi-pro players in the same position group. A
  // cohort too small to compare says so instead of giving a number.
  playerRouter.get('/benchmarks', (req, res) => {
    if (grassrootsOnly(req, res)) return;
    // The cohort (inCohort: not pro, the same position track) is a SQL filter: light rows for the stats, one GROUP BY
    // for the drill bests.
    const track = trackForPosition(req.player.position);
    const cohortFilter = { notLevel: 'pro', exceptId: req.player.id, positions: PLAYER_POSITIONS.filter((pos) => trackForPosition(pos) === track), orNoPosition: trackForPosition(null) === track };
    const cohort = [];
    players.scanLight(cohortFilter, (c) => { if (inCohort(req.player, c)) cohort.push(c); });
    const bests = players.drillBests(cohortFilter);
    const myBest = (drillId, lowerIsBetter) => {
      const values = (req.player.drillResults ?? []).filter((r) => r.drillId === drillId).map((r) => r.value);
      if (!values.length) return null;
      return lowerIsBetter ? Math.min(...values) : Math.max(...values);
    };
    const drills = DRILLS.map((d) => {
      const mine = myBest(d.id, d.lowerIsBetter);
      if (mine === null) return null;
      const cohortValues = (bests.get(d.id) ?? []).map((b) => (d.lowerIsBetter ? b.min : b.max));
      const percentile = percentileAmong(mine, cohortValues, d.lowerIsBetter);
      return { drillId: d.id, name: d.name, metric: d.metric, unit: d.unit, value: mine, percentile, sampleSize: cohortValues.length, insufficient: percentile === null };
    }).filter(Boolean);
    const stats = ['goals', 'assists', 'appearances', 'passCompletionPct', 'duelSuccessPct'].map((k) => {
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

  // ------------------------------------------------------------ the radar and open days
  playerRouter.get('/opportunities', (req, res) => {
    if (grassrootsOnly(req, res)) return;
    if (!req.player.location) return res.json({ clubs: [], note: 'Set your location to see clubs within reach.' });
    const near = orgs.locatedInBox(boxAround(req.player.location, GRASSROOTS_RADIUS_KM), { level: 'grassroots' })
      .map((o) => ({ org: o, distanceKm: Math.round(haversineKm(o.location, req.player.location) * 10) / 10 }))
      .filter((x) => x.distanceKm <= GRASSROOTS_RADIUS_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm);
    const upcoming = Map.groupBy(grassroots.openTrials.upcomingForOrgs(near.map((x) => x.org.id), new Date().toISOString().slice(0, 10)), (t) => t.orgId);
    const clubs = near.map(({ org, distanceKm }) => ({
      id: org.id, name: org.name, city: org.location.city ?? '', distanceKm,
      verified: org.verified, safeguardingCertified: safeguardingCertified(org),
      ...pathwayRecord(org),
      lookingFor: [...clubSetup.lookingFor.forOrg(org.id)],
      openTrials: (upcoming.get(org.id) ?? []).map((t) => ({ ...openTrialView(t), registered: t.registrations.some((r) => r.playerId === req.player.id) })),
    }));
    res.json({ radiusKm: GRASSROOTS_RADIUS_KM, clubs, lookingForYou: clubs.filter((c) => c.lookingFor.includes(req.player.position)).length });
  });

  playerRouter.post('/open-trials/:id/register', (req, res) => {
    if (grassrootsOnly(req, res)) return;
    if (guardianManagedOnly(req, res)) return;
    const trial = grassroots.openTrials.byId(req.params.id);
    if (!trial) return res.status(404).json({ error: 'OPEN_TRIAL_NOT_FOUND' });
    const org = findOrg(trial.orgId);
    if (!org || !req.player.location || !org.location || haversineKm(org.location, req.player.location) > GRASSROOTS_RADIUS_KM) {
      return res.status(403).json({ error: 'OUT_OF_RADIUS', message: 'Open days are local — this one is beyond 50km of you.' });
    }
    if (trial.registrations.some((r) => r.playerId === req.player.id)) return res.status(409).json({ error: 'ALREADY_REGISTERED' });
    unit(() => {
      grassroots.openTrials.register(trial.id, { id: nextId('otr'), playerId: req.player.id, playerName: req.player.name?.slice(0, GL.playerName) ?? null, byGuardian: false, guardianId: null, ts: Date.now() });
      ledgerAppend({ type: 'open_trial_registration', playerId: req.player.id, orgId: org.id, orgName: org.name, userId: trial.createdByUserId, scoutName: 'open day' });
      notify({ kind: 'org_user', id: trial.createdByUserId }, 'open_trial', `${req.player.name} registered for "${trial.title}".`, trial.id);
    });
    res.status(201).json({ registered: true });
  });

  // The open days near a child, for the guardian, only from clubs allowed to see the child at all. Past days stay
  // listed, so a parent still sees the one their child registered for.
  guardianRouter.get('/children/:id/open-trials', (req, res) => {
    const child = ownChild(req, res, findPlayer); if (!child) return;
    if (!child.location) return res.json({ openTrials: [], note: 'Set a location on the profile to see local open days.' });
    const list = grassroots.openTrials.inBox(boxAround(child.location, GRASSROOTS_RADIUS_KM))
      .map((t) => ({ t, org: findOrg(t.orgId) }))
      .filter(({ org }) => org?.level === 'grassroots' && org.location && haversineKm(org.location, child.location) <= GRASSROOTS_RADIUS_KM)
      .filter(({ org }) => visibleToOrg(child, org))
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
    const child = ownChild(req, res, findPlayer, req.body?.childId); if (!child) return;
    const trial = grassroots.openTrials.byId(req.params.id);
    if (!trial) return res.status(404).json({ error: 'OPEN_TRIAL_NOT_FOUND' });
    const org = findOrg(trial.orgId);
    if (!org || !visibleToOrg(child, org)) {
      return res.status(403).json({ error: 'VERIFIED_CLUBS_ONLY', message: 'Only verified, local clubs can receive an under-18 registration.' });
    }
    if (trial.registrations.some((r) => r.playerId === child.id)) return res.status(409).json({ error: 'ALREADY_REGISTERED' });
    unit(() => {
      grassroots.openTrials.register(trial.id, { id: nextId('otr'), playerId: child.id, playerName: child.name?.slice(0, GL.playerName) ?? null, byGuardian: true, guardianId: req.guardian.id, ts: Date.now() });
      ledgerAppend({ type: 'open_trial_registration_by_guardian', playerId: child.id, orgId: org.id, orgName: org.name, userId: trial.createdByUserId, scoutName: 'open day' });
      notify({ kind: 'org_user', id: trial.createdByUserId }, 'open_trial', `${child.name} (via guardian) registered for "${trial.title}".`, trial.id);
      notify({ kind: 'player', id: child.id }, 'open_trial', `Your parent/guardian registered you for ${org.name}'s open day "${trial.title}" — good luck!`, trial.id);
    });
    res.status(201).json({ registered: true });
  });

  // ------------------------------------------------------------ First Team Seekers: need-based, free, never purchasable
  const setSeeker = (player, req, res) => {
    if (switchRefused(res, req.body?.enabled, 'enabled')) return;
    const stored = players.setFirstTeamSeeker(player.id, req.body.enabled);
    broadcast('players', { playerId: player.id });
    res.json({ firstTeamSeeker: stored.firstTeamSeeker });
  };
  playerRouter.post('/first-team-seeker', (req, res) => {
    if (grassrootsOnly(req, res)) return;
    if (guardianManagedOnly(req, res)) return;
    setSeeker(req.player, req, res);
  });
  guardianRouter.post('/children/:id/first-team-seeker', (req, res) => {
    const child = grassrootsChild(req, res); if (!child) return;
    setSeeker(child, req, res);
  });

  // ------------------------------------------------------------ coach references
  // The coach proves control of the mailbox with a one-time code (stored only as its hash); the reference text is
  // moderated when it is submitted.
  function requestVouch(player, { coachName, coachEmail, role }, res) {
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
    // In a unit, so the id counter commits with the row. A player's name has no limit at sign-up: it is shortened, never refused.
    const vouch = unit(() => transitionsVouches.vouches.create({
      id: nextId('vch'), playerId: player.id, playerName: player.name?.slice(0, VL.name) ?? null,
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
    }).catch((err) => console.error(`reference request ${vouch.id}: the mail was not recorded or sent (${err?.code ?? err?.message ?? err})`));
    res.status(201).json({ requested: true, vouchId: vouch.id });
  }
  playerRouter.post('/vouches/request', (req, res) => {
    if (grassrootsOnly(req, res)) return;
    if (guardianManagedOnly(req, res)) return;
    requestVouch(req.player, req.body ?? {}, res);
  });
  guardianRouter.post('/children/:id/vouches/request', (req, res) => {
    const child = grassrootsChild(req, res); if (!child) return;
    requestVouch(child, req.body ?? {}, res);
  });

  // ------------------------------------------------------------ the season wrap: the year in one card
  playerRouter.get('/season-wrap', (req, res) => {
    if (grassrootsOnly(req, res)) return;
    const p = req.player;
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
      scoutViews: scoutViewsOf(p.id),
      note: 'Your season, verified. Every number above is backed by the ledger — no vanity metrics.',
    });
  });
}
