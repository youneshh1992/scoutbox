// M15 — Football Passport assembly + routes.
//
// The server assembles ONE canonical projection per (player, viewer) from
// existing domain records; clients never rebuild the Passport from raw
// endpoints. Authorization reuses the standing gates verbatim:
// visibleToOrg (incl. the agency/minor wall and the grassroots 50 km rule),
// blocks, guardian ownership, adult checks. Passport adds no new access.
import { isAdult, visibleToOrg } from '../domain.mjs';
import {
  buildTimeline, clubHistory, currentStatus, temporalConflicts, completeness,
  projectPassport, normWhen, whenDisplay, evId, PROVENANCE_COPY,
} from './shared.mjs';
// M16: the Passport PROJECTS Box Cam data — it never copies it.
import { developmentActivity as boxDevelopmentActivity, fmtMs as boxFmtMs } from '../m16/shared.mjs';
import { DRILLS as BOX_DRILLS, latestDrill as boxLatestDrill } from '../m16/drills.mjs';

const BOX_DRILLS_BY_ID = new Map(BOX_DRILLS.map((d) => [d.id, d]));

export function registerPassportCore(ctx) {
  const {
    db, playerRouter, guardianRouter, orgRouter, adminRouter,
    nextId, persist, persistNow, notify, ledgerAppend, findPlayer, isBlocked,
    moderateOrRefuse, vmetric,
  } = ctx;

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  const orgOf = (id) => db.orgs.find((o) => o.id === id) ?? null;
  const prefsFor = (playerId) => {
    let p = db.passportPrefs.find((x) => x.playerId === playerId);
    if (!p) {
      p = { playerId, bio: null, positions: null, positionHistory: [], availability: null, availableFrom: null, publicSelections: [], updatedAt: null };
      db.passportPrefs.push(p);
    }
    return p;
  };
  ctx.passportPrefsFor = prefsFor;
  ctx.orgCanSee = orgCanSee;

  // ------------------------------------------------------ source assembly
  // Reads existing collections; writes nothing. `light` skips the timeline
  // for batch summaries (§62 — no full history for 100 players).
  function assemble(player, { light = false } = {}) {
    const pid = player.id;
    const prefs = prefsFor(pid);
    const now = Date.now();

    // Club relationships: squad rows (invite-approved), accepted M14 squad
    // invitations, signings; plus self/guardian-submitted career entries.
    const squads = [];
    for (const o of db.orgs) {
      if (o.suspended) continue; // a suspended organisation lends no CURRENT relationship (§79#20)
      for (const row of o.squad ?? []) {
        if (row.playerId === pid) squads.push({ orgId: o.id, orgName: o.name, rowId: row.id, addedAt: row.addedAt, orgVerified: !!o.verified });
      }
    }
    for (const inv of db.verPlayerInvites ?? []) {
      if (inv.playerId === pid && inv.status === 'accepted' && !squads.some((s) => s.orgId === inv.orgId)) {
        const o = orgOf(inv.orgId);
        if (!o || o.suspended) continue; // same suspension rule as squad rows (§79#20)
        squads.push({ orgId: inv.orgId, orgName: o.name, rowId: inv.id, addedAt: inv.acceptedAt, orgVerified: !!o.verified });
      }
    }
    const signings = db.signings.filter((s) => s.playerId === pid);
    const outcomes = db.outcomeReports.filter((o) => o.playerId === pid).map((o) => ({ ...o, orgName: orgOf(o.orgId)?.name ?? null }));
    const signingRows = signings.map((s) => {
      const ended = outcomes.find((o) => o.signingId === s.id && ['released', 'ended', 'left'].includes(String(o.registrationStatus ?? '')));
      // Suspension suppresses the CURRENT relationship at read time (same
      // policy as M14 badges); the historical signing fact is untouched.
      return { id: s.id, orgId: s.orgId, orgName: s.orgName, ts: s.ts, endedAt: ended?.at ?? null, orgSuspended: !!orgOf(s.orgId)?.suspended };
    });
    const careerEntries = db.passportCareerEntries.filter((c) => c.playerId === pid);

    const trials = db.trials.filter((t) => t.playerId === pid);
    const assessments = db.assessments
      .filter((a) => a.playerId === pid && ['submitted', 'reviewed', 'published'].includes(a.state ?? '') || (a.playerId === pid && a.publishedFeedback))
      .map((a) => ({ ...a, orgName: orgOf(a.orgId)?.name ?? null }));
    const references = (db.verReferences ?? []).filter((r) => r.playerId === pid && r.status === 'active').map((r) => ({
      ...r,
      provenanceStillCurrent: (() => {
        const claim = (db.verClaims ?? []).find((c) => c.id === r.provenanceSnapshot?.claimId);
        return !!claim && claim.status === 'verified' && claim.current !== false;
      })(),
    }));
    const evidence = db.evidence.filter((e) => e.playerId === pid).map((e) => ({
      id: e.id, claimType: e.claimType, label: e.label, recordedAt: e.recordedAt,
      tier: e.verification?.status ?? 'self_reported', sourceKind: e.source?.kind ?? 'player',
      superseded: !!e.supersededBy, expired: e.expiresAt ? e.expiresAt < now : false,
    }));
    const objectives = db.devObjectives.filter((o) => o.playerId === pid).map((o) => ({
      id: o.id, orgId: o.orgId, orgName: orgOf(o.orgId)?.name ?? null, createdAt: o.createdAt,
      status: o.status, completedAt: o.completedAt ?? null, sharingOrgIds: o.sharing?.orgIds ?? [],
    }));
    const applications = db.applications.filter((a) => a.playerId === pid).map((a) => ({
      ...a, orgName: orgOf(a.orgId)?.name ?? null,
      opportunityTitle: db.opportunities.find((o) => o.id === a.opportunityId)?.title ?? null,
    }));
    const transitions = db.transitionCases.filter((t) => t.playerId === pid);
    const representations = db.representations.filter((r) => r.playerId === pid && r.confirmedAt);
    const achievements = db.passportAchievements.filter((a) => a.playerId === pid);
    const vouches = (db.vouches ?? []).filter((v) => v.playerId === pid && v.status === 'published' && !v.withdrawn);

    // M16 Box Cam — displayable (verified/partially verified, never
    // invalidated) sessions, challenge completions and the aggregate
    // development-activity summary.
    const boxSessionsAll = (db.boxSessions ?? []).filter((s) => s.playerId === pid && s.finalizedAt && !['cancelled', 'invalidated'].includes(s.verificationState));
    const boxDisplayable = boxSessionsAll.filter((s) => ['verified', 'partially_verified'].includes(s.verificationState));
    const boxAssignmentsAll = (db.boxAssignments ?? []).filter((a) => a.playerId === pid && !['cancelled', 'superseded'].includes(a.state));
    const boxPrefs = (db.boxCamPrefs ?? []).find((x) => x.playerId === pid) ?? null;
    // Meaningful milestones only — the career timeline is never flooded.
    const boxTimelineSessions = boxDisplayable
      .filter((s) => s.targetCompleted === true || (s.verifiedActiveMs ?? 0) >= 15 * 60_000)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 10)
      .map((s) => {
        const a = s.assignmentId ? (db.boxAssignments ?? []).find((x) => x.id === s.assignmentId) : null;
        return {
          id: s.id, endedAt: s.endedAt, drillTitle: boxLatestDrill(s.drillId)?.title ?? s.drillId,
          verifiedActive: boxFmtMs(s.verifiedActiveMs ?? 0), verifiedReps: s.verifiedReps ?? null,
          targetCompleted: s.targetCompleted, assignedByOrg: a ? { id: a.orgId, name: a.orgName } : null,
        };
      });
    const boxChallengeCompletions = (db.boxChallengeEntries ?? [])
      .filter((e) => e.playerId === pid && e.status === 'completed')
      .map((e) => {
        const c = (db.boxChallenges ?? []).find((x) => x.id === e.challengeId);
        return c ? {
          entryId: e.id, completedAt: e.completedAt, title: c.title,
          publisherName: c.publisher.kind === 'org' ? c.publisher.orgName : 'ScoutBox',
          publisherOrg: c.publisher.kind === 'org' ? { id: c.publisher.orgId, name: c.publisher.orgName } : null,
        } : null;
      })
      .filter(Boolean);

    // Identity: the PLAYER identity surface is the existing IDV outcome —
    // honestly a ScoutBox review, never an authoritative provider.
    const identity = player.identityVerified
      ? { confirmed: true, assurance: 'scoutbox_document_review', label: 'Identity confirmed by ScoutBox review', provenance: PROVENANCE_COPY.scoutbox_reviewed }
      : null;

    const history = clubHistory({ affiliations: [], squads, careerEntries, signingRows });
    const age = (() => {
      const d = new Date(player.dob); const t = new Date();
      let a = t.getFullYear() - d.getFullYear();
      if (t < new Date(t.getFullYear(), d.getMonth(), d.getDate())) a--;
      return a;
    })();

    const fullMatchEvidence = evidence.filter((e) => e.claimType === 'footage' && !e.superseded);
    const recentAssessment = assessments.some((a) => (a.submittedAt ?? a.createdAt) > now - 365 * 86_400_000);
    const lastEvidenceAt = Math.max(0, ...evidence.map((e) => e.recordedAt ?? 0));
    const facts = {
      hasRecentFullMatch: fullMatchEvidence.some((e) => e.recordedAt > now - 180 * 86_400_000),
      fullMatchCount: fullMatchEvidence.length,
      clipCount: (player.media ?? []).length,
      referenceCount: references.length + vouches.length,
      hasConfirmedCurrentClub: history.rows.some((r) => r.current && ['verified_club_confirmed', 'authoritative_registry', 'scoutbox_reviewed'].includes(r.provenance)),
      hasRecentAssessment: recentAssessment,
      hasPosition: !!(prefs.positions?.primary ?? player.position),
      hasAvailability: !!prefs.availability,
      identityConfirmed: !!identity,
      historyRows: history.rows.length,
      hasRecentTrainingEvidence: boxDisplayable.some((s) => (s.endedAt ?? 0) > now - 45 * 86_400_000),
    };

    const full = {
      player: { id: pid, name: player.name, age, minor: !isAdult(player), position: prefs.positions?.primary ?? player.position ?? null, city: player.city ?? player.location?.city ?? null, level: player.level ?? null },
      identity,
      prefs,
      history,
      status: currentStatus({ history, prefs, representations, identity }),
      evidenceSummary: {
        fullMatches: fullMatchEvidence.length,
        clips: (player.media ?? []).length,
        assessments: assessments.length,
        references: references.length + vouches.length,
        lastEvidenceDays: lastEvidenceAt ? Math.floor((now - lastEvidenceAt) / 86_400_000) : null,
        note: 'Counts describe evidence coverage, not football ability.',
      },
      references,
      achievements,
      developmentSummary: {
        active: objectives.filter((o) => o.status === 'active').length,
        completed: objectives.filter((o) => o.status !== 'active').length,
      },
      trialsSummary: { total: trials.length, withReport: trials.filter((t) => t.report).length },
      completeness: completeness(facts),
      developmentActivity: boxDevelopmentActivity({ sessions: boxSessionsAll, assignments: boxAssignmentsAll, drillsById: BOX_DRILLS_BY_ID, days: 30 }),
      boxShareRecruitment: boxPrefs?.shareDevelopmentActivity === 'recruitment',
      sharingSummary: {
        active: db.passportShares.filter((s) => s.playerId === pid && !s.revokedAt && (!s.expiresAt || s.expiresAt > now)).length,
      },
      assessments, trials, objectives, // raw-ish, filtered again at projection
    };

    if (!light) {
      full.timeline = buildTimeline({
        affiliations: [], careerEntries, squads, trials, assessments, references,
        evidence, objectives, applications, transitions, signings, outcomes,
        representations, achievements, positionHistory: prefs.positionHistory,
        boxSessions: boxTimelineSessions, boxChallenges: boxChallengeCompletions,
      });
      full.temporalConflicts = temporalConflicts({ events: full.timeline, history: history.rows, dob: player.dob });
    } else {
      full.timeline = [];
      full.temporalConflicts = [];
    }
    return full;
  }
  ctx.assemblePassport = assemble;

  function buildFor(player, viewerKind, opts = {}) {
    const full = assemble(player, opts);
    if (viewerKind === 'pro_club' || viewerKind === 'grassroots_club' || viewerKind === 'agency') {
      full.assessmentsForOrg = full.assessments.filter((a) => a.orgId === opts.orgId);
      full.trialsForOrg = full.trials.filter((t) => t.orgId === opts.orgId);
    }
    return projectPassport(full, viewerKind, opts);
  }
  ctx.buildFootballPassport = buildFor;

  const viewerKindForOrg = (org) => org.type === 'agency' ? 'agency' : org.level === 'grassroots' ? 'grassroots_club' : 'pro_club';

  // ------------------------------------------------------------- self view
  playerRouter.get('/football-passport', (req, res) => {
    vmetric('views_self');
    res.json(buildFor(req.player, 'self'));
  });

  guardianRouter.get('/children/:id/football-passport', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    vmetric('views_guardian');
    res.json(buildFor(child, 'guardian'));
  });

  // ----------------------------------------------------------- preferences
  function applyPrefs(res, player, body, submittedBy) {
    const p = prefsFor(player.id);
    if (body.bio !== undefined) {
      const bio = body.bio === null ? null : String(body.bio).slice(0, 400);
      if (bio && !moderateOrRefuse(res, bio, { kind: 'passport_bio', playerId: player.id })) return null;
      p.bio = bio;
    }
    if (body.positions !== undefined) {
      p.positions = body.positions ? {
        primary: String(body.positions.primary ?? '').slice(0, 8) || null,
        secondary: Array.isArray(body.positions.secondary) ? body.positions.secondary.slice(0, 3).map((x) => String(x).slice(0, 8)) : [],
      } : null;
    }
    if (body.positionHistoryAdd) {
      const h = body.positionHistoryAdd;
      const from = normWhen(h.from);
      if (!from) { res.status(400).json({ error: 'DATE_REQUIRED', message: 'Position history needs at least a year.' }); return null; }
      p.positionHistory.push({ id: nextId('ppos'), from: h.from, primary: String(h.primary ?? '').slice(0, 8), secondary: Array.isArray(h.secondary) ? h.secondary.slice(0, 3).map((x) => String(x).slice(0, 8)) : [], submittedBy });
    }
    if (body.availability !== undefined) {
      const ALLOWED = ['open_to_trials', 'open_to_contact', 'not_looking', null];
      if (!ALLOWED.includes(body.availability)) { res.status(400).json({ error: 'AVAILABILITY_INVALID', allowed: ALLOWED }); return null; }
      p.availability = body.availability;
    }
    if (body.availableFrom !== undefined) p.availableFrom = body.availableFrom ? String(body.availableFrom).slice(0, 10) : null;
    if (body.publicSelections !== undefined) {
      // Selection is NARROWING-ONLY input: unknown ids are stored harmlessly
      // but can never surface anything the source policy keeps non-public
      // (enforced at projection time, tested in the abuse suite).
      p.publicSelections = Array.isArray(body.publicSelections) ? body.publicSelections.slice(0, 100).map((x) => String(x).slice(0, 120)) : [];
    }
    p.updatedAt = Date.now();
    persistNow();
    return p;
  }

  playerRouter.patch('/football-passport/prefs', (req, res) => {
    const p = applyPrefs(res, req.player, req.body ?? {}, 'player');
    if (p) res.json({ prefs: p });
  });
  guardianRouter.patch('/children/:id/football-passport/prefs', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const p = applyPrefs(res, child, req.body ?? {}, 'guardian');
    if (p) res.json({ prefs: p });
  });

  // --------------------------------------------------- self career entries
  function addCareerEntry(res, player, body, submittedBy) {
    const orgName = String(body.orgName ?? '').trim().slice(0, 100);
    if (!orgName) { res.status(400).json({ error: 'ORG_NAME_REQUIRED' }); return null; }
    if (!moderateOrRefuse(res, orgName + ' ' + String(body.role ?? '') + ' ' + String(body.note ?? ''), { kind: 'passport_career', playerId: player.id })) return null;
    const from = normWhen(body.from);
    if (!from) { res.status(400).json({ error: 'DATE_REQUIRED', message: 'A year is enough — exact dates are never invented.' }); return null; }
    const to = body.to != null ? normWhen(body.to) : null;
    if (body.to != null && !to) { res.status(400).json({ error: 'DATE_INVALID' }); return null; }
    const e = {
      id: nextId('pcar'), playerId: player.id, orgName, role: body.role ? String(body.role).slice(0, 60) : null,
      from: body.from, to: body.to ?? null, note: body.note ? String(body.note).slice(0, 200) : null,
      submittedBy, createdAt: Date.now(), withdrawnAt: null,
    };
    db.passportCareerEntries.push(e);
    persistNow();
    return e;
  }
  playerRouter.post('/football-passport/career', (req, res) => {
    const e = addCareerEntry(res, req.player, req.body ?? {}, 'player');
    if (e) res.status(201).json({ entry: e, provenance: 'player_submitted', note: PROVENANCE_COPY.player_submitted });
  });
  guardianRouter.post('/children/:id/football-passport/career', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const e = addCareerEntry(res, child, req.body ?? {}, 'guardian');
    if (e) res.status(201).json({ entry: e, provenance: 'guardian_submitted' });
  });
  playerRouter.post('/football-passport/career/:id/withdraw', (req, res) => {
    const e = db.passportCareerEntries.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!e) return res.status(404).json({ error: 'ENTRY_NOT_FOUND' });
    e.withdrawnAt = Date.now();
    persistNow();
    res.json({ entry: e, note: 'Self-submitted entries can be withdrawn; confirmed records cannot (request a correction instead).' });
  });

  // ------------------------------------------------------------ achievements
  playerRouter.post('/football-passport/achievements', (req, res) => addAchievement(res, req.player, req.body ?? {}, 'player'));
  guardianRouter.post('/children/:id/football-passport/achievements', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    addAchievement(res, child, req.body ?? {}, 'guardian');
  });
  function addAchievement(res, player, body, submittedBy) {
    const title = String(body.title ?? '').trim().slice(0, 120);
    if (!title) return res.status(400).json({ error: 'TITLE_REQUIRED' });
    if (!moderateOrRefuse(res, title, { kind: 'passport_achievement', playerId: player.id })) return;
    // A client can NEVER assert authoritative provenance for itself (§79#16):
    // whatever the body claims, a new achievement is player/guardian-submitted.
    const a = {
      id: nextId('pach'), playerId: player.id, title, orgName: body.orgName ? String(body.orgName).slice(0, 100) : null,
      when: body.when ?? null, submittedBy, confirmation: null, createdAt: Date.now(), withdrawnAt: null,
    };
    db.passportAchievements.push(a);
    persistNow();
    res.status(201).json({ achievement: a, provenance: submittedBy === 'guardian' ? 'guardian_submitted' : 'player_submitted' });
  }
  playerRouter.post('/football-passport/achievements/:id/withdraw', (req, res) => {
    const a = db.passportAchievements.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!a) return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' });
    if (a.confirmation) return res.status(403).json({ error: 'CONFIRMED_RECORD', message: 'A confirmed achievement is part of the record — request a correction instead of deleting it.' });
    a.withdrawnAt = Date.now();
    persistNow();
    res.json({ achievement: a });
  });
  // Club confirmation upgrades provenance WITHOUT rewriting the original.
  orgRouter.post('/players/:pid/football-passport/achievements/:id/confirm', (req, res) => {
    const p = findPlayer(req.params.pid);
    if (!p || !orgCanSee(req.org, p)) return res.status(p ? 403 : 404).json({ error: p ? (req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE') : 'PLAYER_NOT_FOUND' });
    if (!req.org.verified) return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can confirm an achievement.' });
    const a = db.passportAchievements.find((x) => x.id === req.params.id && x.playerId === p.id && !x.withdrawnAt);
    if (!a) return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' });
    if (a.confirmation) return res.status(409).json({ error: 'ALREADY_CONFIRMED' });
    a.confirmation = { provenance: 'verified_club_confirmed', orgId: req.org.id, orgName: req.org.name, byName: req.orgUser.name, at: Date.now() };
    notify({ kind: 'player', id: p.id }, 'passport', `🏅 ${req.org.name} confirmed your achievement “${a.title}”.`, a.id);
    if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'passport', `${req.org.name} confirmed ${p.name}'s achievement “${a.title}”.`, a.id);
    vmetric('achievement_confirmed');
    persistNow();
    res.json({ achievement: a });
  });

  // ------------------------------------------------------------ corrections
  function fileCorrection(res, player, body, by) {
    const TARGETS = ['timeline_event', 'career_entry', 'club_history', 'reference', 'trial', 'assessment', 'achievement', 'signing'];
    const targetType = String(body.targetType ?? '');
    if (!TARGETS.includes(targetType)) return res.status(400).json({ error: 'TARGET_INVALID', allowed: TARGETS });
    const reason = String(body.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED' });
    if (!moderateOrRefuse(res, reason, { kind: 'passport_correction', playerId: player.id })) return;
    const c = {
      id: nextId('pcor'), playerId: player.id, targetType, targetId: String(body.targetId ?? '').slice(0, 80) || null,
      reason: reason.slice(0, 500), by, status: 'open', resolution: null, createdAt: Date.now(), resolvedAt: null,
    };
    db.passportCorrections.push(c);
    vmetric('correction_filed');
    persistNow();
    res.status(201).json({ correction: c, note: 'Authoritative records are never silently edited — Trust & Safety reviews correction requests, and verification claims can additionally be disputed through the existing verification flow.' });
  }
  playerRouter.post('/football-passport/corrections', (req, res) => fileCorrection(res, req.player, req.body ?? {}, { kind: 'player', id: req.player.id, name: req.player.name }));
  guardianRouter.post('/children/:id/football-passport/corrections', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    fileCorrection(res, child, req.body ?? {}, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  adminRouter.get('/passport/corrections', (req, res) => {
    const open = db.passportCorrections.filter((c) => req.query.all === '1' || c.status === 'open').sort((a, b) => a.createdAt - b.createdAt);
    res.json({ items: open });
  });
  adminRouter.post('/passport/corrections/:id/resolve', (req, res) => {
    const c = db.passportCorrections.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'CORRECTION_NOT_FOUND' });
    if (c.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { resolution, reason } = req.body ?? {};
    if (!['corrected', 'rejected', 'referred'].includes(resolution)) return res.status(400).json({ error: 'RESOLUTION_REQUIRED', allowed: ['corrected', 'rejected', 'referred'] });
    if (!String(reason ?? '').trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    c.status = 'resolved';
    c.resolution = { outcome: resolution, reason: String(reason).slice(0, 400), at: Date.now() };
    c.resolvedAt = Date.now();
    const target = c.by.kind === 'guardian' ? { kind: 'guardian', id: c.by.id } : { kind: 'player', id: c.playerId };
    notify(target, 'passport', `Trust & Safety resolved your Passport correction request: ${resolution}.`, c.id);
    persistNow();
    res.json({ correction: c });
  });

  // ------------------------------------------------------------- club view
  orgRouter.get('/players/:id/football-passport', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) {
      return res.status(403).json({ error: req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE' });
    }
    const viewer = viewerKindForOrg(req.org);
    ledgerAppend({ type: 'passport_recruitment_view', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    vmetric('views_recruitment');
    res.json(buildFor(p, viewer, { orgId: req.org.id }));
  });

  // Batch summaries for list surfaces — light assembly, no timelines (§62).
  orgRouter.get('/football-passports', (req, res) => {
    const ids = String(req.query.ids ?? '').split(',').filter(Boolean).slice(0, 100);
    const items = [];
    for (const id of ids) {
      const p = findPlayer(id);
      if (!p || !orgCanSee(req.org, p)) continue; // concealment: absent, not erroring
      const full = assemble(p, { light: true });
      items.push({
        playerId: p.id,
        position: full.player.position,
        age: full.player.age,
        currentClub: full.status.currentClub ? { name: full.status.currentClub.orgName, provenance: full.status.currentClub.provenance } : null,
        evidenceCoverage: full.completeness.evidenceCoverage,
        lastEvidenceDays: full.evidenceSummary.lastEvidenceDays,
        references: full.evidenceSummary.references,
        availability: full.status.availability,
        identityConfirmed: !!full.identity,
      });
    }
    vmetric('batch_summaries');
    res.json({ items });
  });

  // ------------------------------------------------------------ T&S tools
  adminRouter.get('/passport/:playerId/graph', (req, res) => {
    const p = findPlayer(req.params.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    res.json(buildFor(p, 'trust_safety'));
  });
}
