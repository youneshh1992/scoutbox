// F5 — Structured opportunity board · F6 — Club-run assessment campaigns ·
// F8 — Feedback → development → reassessment · F9 — Trial-day experience.
//
// Everything guardian-routed for minors, everything eligibility-checked
// server-side (fail-closed on missing location), grassroots 50 km preserved.

import { GRASSROOTS_RADIUS_KM, parseTrialDate, trialReportDueAt } from '../domain.mjs';
import { trialFamilyView, trialOutcomeLine } from '../m23/trial.mjs';

export function registerJourneys(ctx) {
  const {
    db, nextId, persistNow, notify, ledgerAppend, broadcast, findPlayer,
    orgRouter, playerRouter, guardianRouter, adminRouter,
    orgCanSee, paginate, audit, requireLead, isLead, moderateOrRefuse, isAdult,
    checkEligibility, distanceBand, guardianOwnsChild, recordActivity, DRILLS,
  } = ctx;

  // ================================================================== F5
  const OPP_TYPES = ['trial', 'open_day', 'programme', 'role'];

  orgRouter.post('/opportunities', (req, res) => {
    const b = req.body ?? {};
    if (!OPP_TYPES.includes(b.type)) return res.status(400).json({ error: 'TYPE_INVALID', allowed: OPP_TYPES });
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'TITLE_REQUIRED' });
    if (!b.deadline) return res.status(400).json({ error: 'DEADLINE_REQUIRED' });
    if (b.description && !moderateOrRefuse(res, b.description, { kind: 'opportunity', orgId: req.org.id })) return;
    const elig = b.eligibility ?? {};
    const opp = {
      id: nextId('opp'), orgId: req.org.id, orgName: req.org.name, orgLevel: req.org.level ?? 'pro',
      type: b.type, title: String(b.title).slice(0, 120), team: b.team ? String(b.team).slice(0, 60) : null,
      category: ['mens', 'womens', 'boys', 'girls', 'mixed'].includes(b.category) ? b.category : 'mixed',
      ageGroup: b.ageGroup ? String(b.ageGroup).slice(0, 20) : null,
      role: b.role ? String(b.role).slice(0, 60) : null,
      description: b.description ? String(b.description).slice(0, 500) : null,
      schedule: b.schedule ? String(b.schedule).slice(0, 200) : null,
      deadline: String(b.deadline).slice(0, 10),
      capacity: Number(b.capacity) || null,
      eligibility: {
        minAge: elig.minAge != null ? Number(elig.minAge) : null,
        maxAge: elig.maxAge != null ? Number(elig.maxAge) : null,
        positionGroup: elig.positionGroup ?? 'any',
        category: opp0Category(b.category),
        maxLevel: req.org.level === 'grassroots' ? 'semi_pro' : (elig.maxLevel ?? null),
        // The 50 km rule is not optional for grassroots orgs.
        radiusKm: req.org.level === 'grassroots' ? GRASSROOTS_RADIUS_KM : (elig.radiusKm != null ? Number(elig.radiusKm) : null),
      },
      requirements: Array.isArray(b.requirements) ? b.requirements.slice(0, 6).map((r) => String(r).slice(0, 120)) : [],
      status: 'published', createdBy: req.orgUser.name, createdAt: Date.now(), closedAt: null,
    };
    db.opportunities.push(opp);
    persistNow();
    broadcast('opportunities', {});
    res.status(201).json({ opportunity: opp });
    function opp0Category(c) { return ['mens', 'womens', 'boys', 'girls'].includes(c) ? c : 'mixed'; }
  });

  const oppOpen = (o) => o.status === 'published' && o.deadline >= new Date().toISOString().slice(0, 10);

  orgRouter.get('/opportunities', (req, res) => {
    const mine = db.opportunities.filter((o) => o.orgId === req.org.id);
    res.json(mine.map((o) => ({
      ...o,
      open: oppOpen(o),
      applications: db.applications.filter((a) => a.opportunityId === o.id && a.status !== 'withdrawn').length,
      outstanding: db.applications.filter((a) => a.opportunityId === o.id && a.status === 'submitted').length,
    })));
  });

  function boardFor(player) {
    // Eligible discovery: the player sees only what they could actually apply
    // to, with the reasons computed the same way the application gate uses.
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const o of db.opportunities.filter(oppOpen)) {
      const org = db.orgs.find((x) => x.id === o.orgId);
      if (!org || org.suspended) continue;
      if (!orgCanSee(org, player)) continue; // visibility is mutual: an org that can't see the player can't receive their application
      const { eligible, reasons } = checkEligibility(o.eligibility, player, org);
      if (!eligible) continue;
      const existing = db.applications.find((a) => a.opportunityId === o.id && a.playerId === player.id && a.status !== 'withdrawn');
      rows.push({
        ...o, via: 'opportunity',
        distance: distanceBand(org.location, player.location),
        applied: existing ? { id: existing.id, status: existing.status } : null,
      });
    }
    // Existing grassroots open days ride the same board — integrated, not
    // duplicated: they keep their own registration flow and records.
    for (const t of db.openTrials.filter((t) => t.date >= today)) {
      const org = db.orgs.find((x) => x.id === t.orgId);
      if (!org || org.suspended || !orgCanSee(org, player)) continue;
      rows.push({
        id: t.id, via: 'open_trial', type: 'open_day', orgId: t.orgId, orgName: org.name,
        title: t.title, deadline: t.date, schedule: t.date, category: 'mixed',
        distance: distanceBand(org.location, player.location),
        applied: (t.registrations ?? []).some((r) => r.playerId === player.id) ? { status: 'registered' } : null,
        note: 'Registered through the open-day flow.',
      });
    }
    return rows.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
  }

  playerRouter.get('/opportunity-board', (req, res) => {
    res.json({ items: boardFor(req.player), minor: req.playerIsMinor, note: req.playerIsMinor ? 'Applications for under-18s are made by your parent/guardian.' : null });
  });

  guardianRouter.get('/children/:id/opportunity-board', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    res.json({ items: boardFor(child) });
  });

  function applyTo(req, res, player, submitter) {
    const o = db.opportunities.find((x) => x.id === req.params.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    if (!oppOpen(o)) return res.status(409).json({ error: 'OPPORTUNITY_CLOSED' });
    const org = db.orgs.find((x) => x.id === o.orgId);
    if (!org || !orgCanSee(org, player)) return res.status(403).json({ error: 'NOT_ELIGIBLE', reasons: ['this club cannot work with this profile'] });
    const { eligible, reasons } = checkEligibility(o.eligibility, player, org);
    if (!eligible) return res.status(403).json({ error: 'NOT_ELIGIBLE', reasons });
    if (db.applications.some((a) => a.opportunityId === o.id && a.playerId === player.id && a.status !== 'withdrawn')) {
      return res.status(409).json({ error: 'ALREADY_APPLIED' });
    }
    if (o.capacity && db.applications.filter((a) => a.opportunityId === o.id && a.status !== 'withdrawn').length >= o.capacity) {
      return res.status(409).json({ error: 'CAPACITY_FULL' });
    }
    const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
    if (note && !moderateOrRefuse(res, note, { kind: 'application', playerId: player.id, orgId: o.orgId })) return;
    const appn = {
      id: nextId('apl'), opportunityId: o.id, orgId: o.orgId, playerId: player.id, playerName: player.name,
      submittedBy: submitter, note, status: 'submitted', outcome: null,
      createdAt: Date.now(), history: [],
    };
    audit(appn, submitter.kind, submitter.id, submitter.name, 'submitted');
    db.applications.push(appn);
    ledgerAppend({ type: 'opportunity_application', playerId: player.id, orgId: o.orgId, orgName: o.orgName, userId: null, scoutName: submitter.name });
    notify({ kind: 'org_user', id: usersOf(o.orgId)[0]?.id ?? '' }, 'application', `📥 ${player.name} applied to "${o.title}".`, appn.id);
    persistNow();
    broadcast('applications', { playerId: player.id });
    res.status(201).json({ application: appn });
  }
  const usersOf = (orgId) => db.users.filter((u) => u.orgId === orgId && !u.removedAt);

  playerRouter.post('/opportunities/:id/apply', (req, res) => {
    if (req.playerIsMinor) {
      // Minors never self-submit club-facing applications: Scout → Parent,
      // and Parent → Club, always.
      return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent or guardian makes applications for you.' });
    }
    applyTo(req, res, req.player, { kind: 'player', id: req.player.id, name: req.player.name });
  });

  guardianRouter.post('/children/:childId/opportunities/:id/apply', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.childId)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.childId);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    applyTo(req, res, child, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  function myApplications(playerIds) {
    return db.applications.filter((a) => playerIds.includes(a.playerId)).map((a) => ({
      ...a, opportunity: (({ id, title, orgName, type, deadline }) => ({ id, title, orgName, type, deadline }))(db.opportunities.find((o) => o.id === a.opportunityId) ?? {}),
    }));
  }
  playerRouter.get('/applications', (req, res) => res.json(myApplications([req.player.id])));
  guardianRouter.get('/applications', (req, res) => res.json(myApplications(req.guardian.childIds)));

  function withdrawApplication(req, res, allowedPlayerIds) {
    const a = db.applications.find((x) => x.id === req.params.id && allowedPlayerIds.includes(x.playerId));
    if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
    if (a.status !== 'submitted') return res.status(409).json({ error: 'NOT_WITHDRAWABLE', status: a.status });
    a.status = 'withdrawn';
    audit(a, 'player', req.player?.id ?? req.guardian.id, req.player?.name ?? req.guardian.name, 'withdrawn');
    persistNow();
    res.json({ application: a });
  }
  playerRouter.post('/applications/:id/withdraw', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED' });
    withdrawApplication(req, res, [req.player.id]);
  });
  guardianRouter.post('/applications/:id/withdraw', (req, res) => withdrawApplication(req, res, req.guardian.childIds));

  orgRouter.get('/opportunities/:id/applications', (req, res) => {
    const o = db.opportunities.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    res.json(paginate(req, db.applications.filter((a) => a.opportunityId === o.id)));
  });

  orgRouter.post('/applications/:id/outcome', (req, res) => {
    const a = db.applications.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
    if (a.outcome) return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    if (a.status === 'withdrawn') return res.status(409).json({ error: 'WITHDRAWN' });
    const { decision, note } = req.body ?? {};
    if (!['accepted', 'declined'].includes(decision)) return res.status(400).json({ error: 'DECISION_INVALID' });
    if (note && !moderateOrRefuse(res, note, { kind: 'application_outcome', playerId: a.playerId, orgId: req.org.id })) return;
    a.status = decision;
    a.outcome = { decision, note: note ? String(note).slice(0, 300) : null, byUserId: req.orgUser.id, byName: req.orgUser.name, at: Date.now() };
    audit(a, 'org', req.orgUser.id, req.orgUser.name, decision);
    const p = findPlayer(a.playerId);
    const text = decision === 'accepted'
      ? `✅ ${req.org.name} accepted the application to "${db.opportunities.find((o) => o.id === a.opportunityId)?.title}". They'll follow up through ScoutBox.`
      : `${req.org.name} on your application: ${a.outcome.note ?? 'not this time — keep playing, keep logging.'}`;
    if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'application', text, a.id);
    else if (p) notify({ kind: 'player', id: p.id }, 'application', text, a.id);
    persistNow();
    broadcast('applications', { playerId: a.playerId });
    res.json({ application: a });
  });

  // No-ghosting extends to the board: closing an opportunity with unresolved
  // applications is refused; the sweep (operations.mjs) nags outstanding ones.
  orgRouter.post('/opportunities/:id/close', (req, res) => {
    const o = db.opportunities.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    const outstanding = db.applications.filter((a) => a.opportunityId === o.id && a.status === 'submitted');
    if (outstanding.length) return res.status(409).json({ error: 'OUTCOMES_OUTSTANDING', count: outstanding.length, message: 'Every applicant gets an answer before the door closes.' });
    o.status = 'closed';
    o.closedAt = Date.now();
    persistNow();
    res.json({ opportunity: o });
  });

  // ================================================================== F6
  // Campaigns: structured remote assessments. The machine checks FILES; a
  // HUMAN checks football. The two verdicts are never conflated.

  // Drill library guidance (F6): recording instructions + review status for
  // the existing combine drills. Nothing is "professionally validated" unless
  // a named reviewer actually reviewed it — seeds start unreviewed.
  db.drillGuidance ??= DRILLS.map((d) => ({
    drillId: d.id,
    recording: { equipment: 'Any phone camera ≥ 720p', distance: 'Full drill area in frame', surface: 'Flat grass or turf', camera: 'Fixed position, side-on, no zooming during the attempt' },
    coachReview: { status: 'unreviewed', reviewer: null, at: null },
  }));

  playerRouter.get('/drill-guidance', (_req, res) => {
    res.json({ items: db.drillGuidance, note: 'Coach review status is shown honestly — "unreviewed" guidance has not been validated by a professional.' });
  });

  adminRouter.get('/drill-guidance', (_req, res) => res.json({ items: db.drillGuidance }));

  adminRouter.post('/drill-guidance/:drillId/review', (req, res) => {
    const g = db.drillGuidance.find((x) => x.drillId === req.params.drillId);
    if (!g) return res.status(404).json({ error: 'DRILL_NOT_FOUND' });
    g.coachReview = { status: 'reviewed', reviewer: String(req.body?.reviewer ?? 'T&S football staff').slice(0, 60), at: Date.now() };
    persistNow();
    res.json({ guidance: g });
  });

  orgRouter.post('/campaigns', (req, res) => {
    const b = req.body ?? {};
    if (!b.title || !Array.isArray(b.drills) || !b.drills.length) return res.status(400).json({ error: 'TITLE_AND_DRILLS_REQUIRED' });
    if (!b.deadline) return res.status(400).json({ error: 'DEADLINE_REQUIRED' });
    const camp = {
      id: nextId('cmp'), orgId: req.org.id, orgName: req.org.name,
      title: String(b.title).slice(0, 120),
      drills: b.drills.slice(0, 6).map((d) => ({
        name: String(d.name ?? '').slice(0, 80),
        instructions: String(d.instructions ?? '').slice(0, 400),
        recording: {
          equipment: String(d.recording?.equipment ?? 'Any phone camera').slice(0, 120),
          distance: String(d.recording?.distance ?? 'Full area in frame').slice(0, 120),
          surface: String(d.recording?.surface ?? 'Flat grass/turf').slice(0, 120),
          camera: String(d.recording?.camera ?? 'Fixed, side-on').slice(0, 120),
        },
      })),
      deadline: String(b.deadline).slice(0, 10),
      attemptsAllowed: Math.min(Math.max(Number(b.attemptsAllowed) || 2, 1), 5),
      eligibility: {
        minAge: b.eligibility?.minAge != null ? Number(b.eligibility.minAge) : null,
        maxAge: b.eligibility?.maxAge != null ? Number(b.eligibility.maxAge) : null,
        positionGroup: b.eligibility?.positionGroup ?? 'any',
        maxLevel: req.org.level === 'grassroots' ? 'semi_pro' : (b.eligibility?.maxLevel ?? null),
        radiusKm: req.org.level === 'grassroots' ? GRASSROOTS_RADIUS_KM : (b.eligibility?.radiusKm != null ? Number(b.eligibility.radiusKm) : null),
      },
      rubric: Array.isArray(b.rubric) ? b.rubric.slice(0, 8).map((r) => ({ criterion: String(r.criterion ?? '').slice(0, 100), guidance: String(r.guidance ?? '').slice(0, 200) })) : [],
      status: 'published', createdBy: req.orgUser.name, createdAt: Date.now(),
    };
    db.campaigns.push(camp);
    persistNow();
    broadcast('campaigns', {});
    res.status(201).json({ campaign: camp });
  });

  orgRouter.get('/campaigns', (req, res) => {
    res.json(db.campaigns.filter((c) => c.orgId === req.org.id).map((c) => ({
      ...c,
      submissions: db.campaignSubmissions.filter((s) => s.campaignId === c.id).length,
      awaitingReview: db.campaignSubmissions.filter((s) => s.campaignId === c.id && s.attempts.some((a) => a.status === 'submitted' && a.fileChecks.passed)).length,
    })));
  });

  const campOpen = (c) => c.status === 'published' && c.deadline >= new Date().toISOString().slice(0, 10);

  function campaignsFor(player) {
    return db.campaigns.filter(campOpen).map((c) => {
      const org = db.orgs.find((o) => o.id === c.orgId);
      if (!org || org.suspended || !orgCanSee(org, player)) return null;
      const { eligible } = checkEligibility(c.eligibility, player, org);
      if (!eligible) return null;
      const sub = db.campaignSubmissions.find((s) => s.campaignId === c.id && s.playerId === player.id);
      return { ...c, mySubmission: sub ?? null };
    }).filter(Boolean);
  }

  playerRouter.get('/campaigns', (req, res) => res.json({ items: campaignsFor(req.player) }));
  guardianRouter.get('/children/:id/campaigns', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    res.json({ items: campaignsFor(child) });
  });

  // The automated tier: FILE checks only — the media exists, it is video,
  // it is inside the size cap. Says nothing about drill execution.
  function fileChecks(player, mediaId) {
    const issues = [];
    const media = player.media.find((m) => m.id === mediaId);
    if (!media) issues.push('attach the recorded video before submitting');
    else {
      if (media.kind !== 'video') issues.push('the attached file is not a video');
      if (!media.url && !db.mediaBlobs?.[media.id] && !media.id.startsWith('media-seed')) {
        // url null AND no stored blob → metadata-only entry
        issues.push('the video file itself was never uploaded');
      }
    }
    return { passed: issues.length === 0, issues, checkedAt: Date.now(), kind: 'automated_file_check' };
  }

  function submitAttempt(req, res, player, submitter) {
    const camp = db.campaigns.find((c) => c.id === req.params.id);
    if (!camp) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
    if (!campOpen(camp)) return res.status(409).json({ error: 'CAMPAIGN_CLOSED' });
    const org = db.orgs.find((o) => o.id === camp.orgId);
    const { eligible, reasons } = checkEligibility(camp.eligibility, player, org);
    if (!org || !orgCanSee(org, player) || !eligible) return res.status(403).json({ error: 'NOT_ELIGIBLE', reasons: reasons ?? [] });
    let sub = db.campaignSubmissions.find((s) => s.campaignId === camp.id && s.playerId === player.id);
    if (!sub) {
      sub = { id: nextId('csb'), campaignId: camp.id, orgId: camp.orgId, playerId: player.id, playerName: player.name, submittedBy: submitter, attempts: [], createdAt: Date.now() };
      db.campaignSubmissions.push(sub);
    }
    // Only attempts that actually reached review (or passed it) count against
    // the policy — a failed FILE check never burns a football attempt.
    const activeAttempts = sub.attempts.filter((a) => ['submitted', 'accepted'].includes(a.status)).length;
    if (activeAttempts >= camp.attemptsAllowed) return res.status(409).json({ error: 'ATTEMPTS_EXHAUSTED', allowed: camp.attemptsAllowed });
    const { mediaId, drillName, note } = req.body ?? {};
    if (note && !moderateOrRefuse(res, note, { kind: 'campaign_note', playerId: player.id, orgId: camp.orgId })) return;
    const checks = fileChecks(player, mediaId);
    const attempt = {
      id: nextId('att'), mediaId: mediaId ?? null, drillName: drillName ? String(drillName).slice(0, 80) : camp.drills[0]?.name,
      note: note ? String(note).slice(0, 300) : null,
      fileChecks: checks,
      // Human review is a SEPARATE state — an attempt passing file checks is
      // "submitted", never "verified".
      status: checks.passed ? 'submitted' : 'failed_checks',
      review: null, submittedAt: Date.now(),
    };
    sub.attempts.push(attempt);
    if (checks.passed) notify({ kind: 'org_user', id: usersOf(camp.orgId)[0]?.id ?? '' }, 'campaign', `🎬 ${player.name} submitted an attempt to "${camp.title}" — human review needed.`, sub.id);
    persistNow();
    res.status(201).json({ attempt, submission: sub, note: checks.passed ? 'File checks passed. A coach still has to review the drill itself — that is a separate, human step.' : 'Automated file checks failed — fix the issues and resubmit.' });
  }

  playerRouter.post('/campaigns/:id/submit', (req, res) => {
    // Campaign attempts are football activity (like drills), so an eligible
    // minor may upload; all club-facing review conversation stays org↔guardian.
    submitAttempt(req, res, req.player, { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.post('/children/:childId/campaigns/:id/submit', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.childId)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    submitAttempt(req, res, findPlayer(req.params.childId), { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  orgRouter.get('/campaigns/:id/review-queue', (req, res) => {
    const camp = db.campaigns.find((c) => c.id === req.params.id && c.orgId === req.org.id);
    if (!camp) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
    const queue = db.campaignSubmissions
      .filter((s) => s.campaignId === camp.id)
      .flatMap((s) => s.attempts.filter((a) => a.status === 'submitted').map((a) => ({ submissionId: s.id, playerId: s.playerId, playerName: s.playerName, attempt: { ...a, mediaUrl: a.mediaId ? `/media/${a.mediaId}` : null } })));
    res.json({ campaign: { id: camp.id, title: camp.title, rubric: camp.rubric }, queue });
  });

  orgRouter.post('/campaign-attempts/:id/review', (req, res) => {
    const sub = db.campaignSubmissions.find((s) => s.orgId === req.org.id && s.attempts.some((a) => a.id === req.params.id));
    const attempt = sub?.attempts.find((a) => a.id === req.params.id);
    if (!attempt) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    if (attempt.status !== 'submitted') return res.status(409).json({ error: 'NOT_REVIEWABLE', status: attempt.status });
    const { decision, reasons, rubricNotes } = req.body ?? {};
    if (!['accepted', 'returned'].includes(decision)) return res.status(400).json({ error: 'DECISION_INVALID' });
    if (decision === 'returned' && (!reasons || !String(reasons).trim())) {
      return res.status(400).json({ error: 'REASONS_REQUIRED', message: 'A returned attempt tells the player exactly what to fix and how to resubmit.' });
    }
    if (reasons && !moderateOrRefuse(res, String(reasons), { kind: 'campaign_review', playerId: sub.playerId, orgId: req.org.id })) return;
    attempt.status = decision;
    attempt.review = {
      byUserId: req.orgUser.id, byName: req.orgUser.name, at: Date.now(),
      kind: 'human_review',
      reasons: reasons ? String(reasons).slice(0, 400) : null,
      rubricNotes: rubricNotes ? String(rubricNotes).slice(0, 400) : null,
    };
    const p = findPlayer(sub.playerId);
    const camp = db.campaigns.find((c) => c.id === sub.campaignId);
    const text = decision === 'accepted'
      ? `✅ Your "${camp?.title}" attempt was reviewed and accepted by ${req.org.name}.`
      : `↩️ ${req.org.name} returned your "${camp?.title}" attempt: ${attempt.review.reasons} — you can resubmit.`;
    if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'campaign', `${p.name}: ${text}`, sub.id);
    if (p) notify({ kind: 'player', id: p.id }, 'campaign', text, sub.id);
    if (p && decision === 'accepted') recordActivity(p);
    persistNow();
    res.json({ attempt });
  });

  // ================================================================== F8
  // Feedback → objectives → reassessment. Private assessments never leak
  // into objectives; only the published feedback record can seed one, and
  // sharing progress back is the player's (or guardian's) explicit choice.

  function objectiveActorFor(req, childId) {
    if (childId) return { player: findPlayer(childId), actor: { kind: 'guardian', id: req.guardian.id, name: req.guardian.name } };
    return { player: req.player, actor: { kind: 'player', id: req.player.id, name: req.player.name } };
  }

  function createObjective(req, res, player, actor) {
    const { feedbackId, objectives } = req.body ?? {};
    const a = db.assessments.find((x) => x.id === feedbackId && x.playerId === player.id && x.publishedFeedback);
    if (!a) return res.status(404).json({ error: 'PUBLISHED_FEEDBACK_NOT_FOUND', message: 'Objectives grow from feedback a club chose to publish — private assessments cannot seed them.' });
    if (!Array.isArray(objectives) || objectives.length < 1 || objectives.length > 2) {
      return res.status(400).json({ error: 'ONE_OR_TWO_OBJECTIVES', message: 'One or two focused objectives — not a laundry list.' });
    }
    const rec = {
      id: nextId('obj'), playerId: player.id, sourceFeedbackId: a.id, orgId: a.orgId,
      reviewer: { userId: a.publishedFeedback.byUserId, name: a.publishedFeedback.byName, orgName: db.orgs.find((o) => o.id === a.orgId)?.name },
      objectives: objectives.map((o) => ({
        id: nextId('objx'), text: String(o.text ?? '').slice(0, 200),
        exerciseRefs: Array.isArray(o.exerciseRefs) ? o.exerciseRefs.slice(0, 4) : [],
        baselineEvidenceIds: (Array.isArray(o.baselineEvidenceIds) ? o.baselineEvidenceIds : []).filter((id) => db.evidence.some((e) => e.id === id && e.playerId === player.id)),
      })),
      progress: [], sharing: { orgIds: [] },
      reassessments: [], reviewAt: req.body?.reviewAt ?? null,
      status: 'active', createdBy: actor, createdAt: Date.now(),
    };
    db.devObjectives.push(rec);
    persistNow();
    res.status(201).json({ objective: rec });
  }

  playerRouter.post('/objectives', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian agrees development objectives with clubs.' });
    createObjective(req, res, req.player, { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.post('/children/:id/objectives', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    createObjective(req, res, findPlayer(req.params.id), { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  const objectivesFor = (playerIds) => db.devObjectives.filter((o) => playerIds.includes(o.playerId));
  playerRouter.get('/objectives', (req, res) => res.json(objectivesFor([req.player.id])));
  guardianRouter.get('/children/:id/objectives', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    res.json(objectivesFor([req.params.id]));
  });

  // Progress: players (minors included — it's football activity) log
  // completions and follow-up evidence against their own objectives.
  playerRouter.post('/objectives/:id/progress', (req, res) => {
    const o = db.devObjectives.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!o) return res.status(404).json({ error: 'OBJECTIVE_NOT_FOUND' });
    const { note, evidenceId, objectiveId } = req.body ?? {};
    if (evidenceId && !db.evidence.some((e) => e.id === evidenceId && e.playerId === req.player.id)) return res.status(400).json({ error: 'EVIDENCE_INVALID' });
    o.progress.push({ id: nextId('prg'), at: Date.now(), objectiveId: objectiveId ?? null, note: note ? String(note).slice(0, 300) : null, evidenceId: evidenceId ?? null });
    recordActivity(req.player);
    persistNow();
    res.status(201).json({ objective: o });
  });

  function setSharing(req, res, playerIds) {
    const o = db.devObjectives.find((x) => x.id === req.params.id && playerIds.includes(x.playerId));
    if (!o) return res.status(404).json({ error: 'OBJECTIVE_NOT_FOUND' });
    const { orgId, enabled } = req.body ?? {};
    if (!db.orgs.some((x) => x.id === orgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    if (enabled && !o.sharing.orgIds.includes(orgId)) o.sharing.orgIds.push(orgId);
    if (!enabled) o.sharing.orgIds = o.sharing.orgIds.filter((x) => x !== orgId);
    persistNow();
    res.json({ objective: o });
  }
  playerRouter.post('/objectives/:id/share', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Sharing progress with a club is a guardian decision for under-18s.' });
    setSharing(req, res, [req.player.id]);
  });
  guardianRouter.post('/objectives/:id/share', (req, res) => setSharing(req, res, req.guardian.childIds));

  function requestReassessment(req, res, playerIds, actor) {
    const o = db.devObjectives.find((x) => x.id === req.params.id && playerIds.includes(x.playerId));
    if (!o) return res.status(404).json({ error: 'OBJECTIVE_NOT_FOUND' });
    if (!o.sharing.orgIds.includes(o.orgId)) return res.status(409).json({ error: 'SHARING_REQUIRED', message: 'Share progress with the club before asking them to look again.' });
    if (o.reassessments.some((r) => r.status === 'requested')) return res.status(409).json({ error: 'ALREADY_REQUESTED' });
    const r = { id: nextId('ras'), requestedBy: actor, requestedAt: Date.now(), status: 'requested', outcome: null };
    o.reassessments.push(r);
    const p = findPlayer(o.playerId);
    notify({ kind: 'org_user', id: o.reviewer.userId }, 'reassessment', `🔁 ${p?.name} (via ${actor.name}) requests a reassessment on: ${o.objectives.map((x) => x.text).join(' · ')}`, o.id);
    persistNow();
    res.status(201).json({ reassessment: r });
  }
  playerRouter.post('/objectives/:id/reassessment', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Re-engaging a club for you is your guardian’s call.' });
    requestReassessment(req, res, [req.player.id], { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.post('/objectives/:id/reassessment', (req, res) =>
    requestReassessment(req, res, req.guardian.childIds, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name }));

  // Club follow-up: sees only SHARED objectives; outcomes cite evidence.
  orgRouter.get('/players/:id/objectives', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || !orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    res.json(db.devObjectives.filter((o) => o.playerId === p.id && o.sharing.orgIds.includes(req.org.id)));
  });

  orgRouter.post('/reassessments/:id/outcome', (req, res) => {
    const o = db.devObjectives.find((x) => x.reassessments.some((r) => r.id === req.params.id));
    const r = o?.reassessments.find((x) => x.id === req.params.id);
    if (!r || o.orgId !== req.org.id) return res.status(404).json({ error: 'REASSESSMENT_NOT_FOUND' });
    if (!o.sharing.orgIds.includes(req.org.id)) return res.status(403).json({ error: 'SHARING_REVOKED' });
    if (r.status !== 'requested') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { note, evidenceIds } = req.body ?? {};
    if (!note || !String(note).trim()) return res.status(400).json({ error: 'NOTE_REQUIRED', message: 'Reassessment outcomes point at evidence, not vibes.' });
    if (!moderateOrRefuse(res, String(note), { kind: 'reassessment_outcome', playerId: o.playerId, orgId: req.org.id })) return;
    r.status = 'completed';
    r.outcome = {
      note: String(note).slice(0, 500),
      evidenceIds: (Array.isArray(evidenceIds) ? evidenceIds : []).filter((id) => db.evidence.some((e) => e.id === id && e.playerId === o.playerId)),
      byUserId: req.orgUser.id, byName: req.orgUser.name, at: Date.now(),
    };
    const p = findPlayer(o.playerId);
    const text = `📝 ${req.org.name} completed the reassessment: ${r.outcome.note.slice(0, 120)}`;
    if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'reassessment', text, o.id);
    else if (p) notify({ kind: 'player', id: p.id }, 'reassessment', text, o.id);
    persistNow();
    res.json({ reassessment: r });
  });

  // ================================================================== F9
  // Trial-day: named staff with check STATES (a reference on file is not a
  // completed check), event consent, restricted emergency info, check-in
  // feeding existing attendance without duplicates, honest cancellation.

  const CHECK_STATES = ['pending', 'reviewed', 'expired', 'rejected'];

  function trialFor(req, res) {
    const t = db.trials.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!t) { res.status(404).json({ error: 'TRIAL_NOT_FOUND' }); return null; }
    // M23 P4A-D14: a tombstoned trial (its subject removed their account) can
    // still be READ — the record of what happened is the club's — but nothing
    // new is written about a person who left.
    if (t.subjectRemovedAt && req.method !== 'GET') {
      res.status(409).json({ error: 'TRIAL_SUBJECT_REMOVED', message: 'This player removed their ScoutBox account. The trial stays on record; it can no longer be changed.' });
      return null;
    }
    t.day ??= { staff: [], consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [] };
    return t;
  }

  orgRouter.get('/trials/:id/day', (req, res) => {
    const t = trialFor(req, res);
    if (t) res.json({ trial: trialDayView(t, 'org') });
  });

  function checkState(c) {
    if (!c) return 'missing';
    if (c.status === 'reviewed' && c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()) return 'expired';
    return c.status;
  }

  function trialDayView(t, side) {
    const day = t.day ?? {};
    const base = {
      id: t.id, playerId: t.playerId, playerName: t.playerName, orgId: t.orgId, orgName: t.orgName,
      proposedDate: t.proposedDate, venue: t.venue, reportDueAt: t.reportDueAt,
      staff: (day.staff ?? []).map((s) => ({ id: s.id, name: s.name, role: s.role, check: { kind: s.check?.kind ?? null, status: checkState(s.check), expiresAt: s.check?.expiresAt ?? null } })),
      arrival: day.arrival, collection: day.collection,
      consents: (day.consents ?? []).map((c) => ({ id: c.id, byKind: c.by.kind, scope: c.scope, at: c.at })),
      checkins: day.checkins ?? [],
      statusEvents: day.statusEvents ?? [],
      cancelled: (day.statusEvents ?? []).some((e) => e.kind === 'cancelled'),
    };
    if (side === 'org') {
      // The emergency contact is for the day's named safety staff, not for
      // scout browsing — it appears here and NOWHERE else (no profile views,
      // no analytics, no exports).
      //
      // M23 P4A-D9: a block placed by the player or guardian ends the
      // organisation's standing to hold the family's contact details. The
      // block is evaluated on every read, like every other block in the
      // product, so the number is withheld the moment the block exists and
      // returns if Trust & Safety lifts it. The rest of the day view (the
      // club's own staff, arrival and status history) is unchanged here;
      // what a blocked club may still DO with a trial is a P4B policy
      // decision (M23_P4A_DECISION_REGISTER.md D-16), not a read-side one.
      const blocked = ctx.isBlocked(t.playerId, t.orgId);
      base.emergency = blocked ? null : (day.emergency ?? null);
      base.emergencyWithheld = blocked ? 'BLOCKED' : null;
    }
    return base;
  }

  orgRouter.post('/trials/:id/staff', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    const { name, role, check } = req.body ?? {};
    if (!name || !role) return res.status(400).json({ error: 'NAME_AND_ROLE_REQUIRED' });
    const s = {
      id: nextId('stf'), name: String(name).slice(0, 80), role: String(role).slice(0, 60),
      check: check ? {
        kind: String(check.kind ?? 'DBS (England & Wales)').slice(0, 60),
        ref: check.ref ? String(check.ref).slice(0, 60) : null,
        // Filing a reference does NOT make it reviewed — Trust & Safety (or
        // the club's safeguarding officer via T&S) moves it to 'reviewed'.
        status: 'pending',
        expiresAt: check.expiresAt ?? null,
        reviewedBy: null,
      } : null,
      addedBy: req.orgUser.name, addedAt: Date.now(),
    };
    t.day.staff.push(s);
    persistNow();
    res.status(201).json({ staff: s, note: 'The check is PENDING until Trust & Safety reviews it — an uploaded reference is not a completed background check.' });
  });

  orgRouter.post('/trials/:id/arrival', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    const { time, address, notes, collection } = req.body ?? {};
    if (notes && !moderateOrRefuse(res, notes, { kind: 'trial_arrival', playerId: t.playerId, orgId: req.org.id })) return;
    t.day.arrival = { time: time ? String(time).slice(0, 40) : null, address: address ? String(address).slice(0, 200) : null, notes: notes ? String(notes).slice(0, 300) : null };
    if (collection) t.day.collection = { policy: String(collection).slice(0, 300) };
    persistNow();
    notifyTrialParties(t, `📍 ${t.orgName} published arrival details for the trial on ${t.proposedDate ?? 'TBC'}.`);
    res.json({ trial: trialDayView(t, 'org') });
  });

  function notifyTrialParties(t, text) {
    const p = findPlayer(t.playerId);
    if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'trial_day', text, t.id);
    if (p) notify({ kind: 'player', id: p.id }, 'trial_day', text, t.id);
  }

  function cancelOrPostpone(req, res, kind) {
    const t = trialFor(req, res);
    if (!t) return;
    const { reason, newDate } = req.body ?? {};
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED' });
    // M23 P4A-D1: a postponement date goes through the one Trial date
    // validator like every other trial date, and the report deadline is
    // re-derived from the new day by the one derivation — never computed here.
    const moved = kind === 'postponed' ? parseTrialDate(newDate) : { ok: true, value: null };
    if (!moved.ok) return res.status(400).json({ ...moved, field: 'newDate' });
    t.day.statusEvents.push({ kind, at: Date.now(), by: req.orgUser.name, reason: String(reason).slice(0, 200), newDate: moved.value });
    if (kind === 'postponed' && moved.value) {
      t.proposedDate = moved.value;
      t.reportDueAt = trialReportDueAt(moved.value, t.acceptedAt);
    }
    persistNow();
    notifyTrialParties(t, kind === 'cancelled'
      ? `❌ ${t.orgName} cancelled the trial: ${reason}`
      : `📅 ${t.orgName} moved the trial to ${newDate ?? 'a new date TBC'}: ${reason}`);
    res.json({ trial: trialDayView(t, 'org') });
  }
  orgRouter.post('/trials/:id/cancel', (req, res) => cancelOrPostpone(req, res, 'cancelled'));
  orgRouter.post('/trials/:id/postpone', (req, res) => cancelOrPostpone(req, res, 'postponed'));

  // The gate: check-in demands a reviewed, unexpired check on at least one
  // named staff member AND the right consent — enforced at the action, 409.
  orgRouter.post('/trials/:id/checkin', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    if (t.day.statusEvents.some((e) => e.kind === 'cancelled')) return res.status(409).json({ error: 'TRIAL_CANCELLED' });
    const okStaff = t.day.staff.some((s) => checkState(s.check) === 'reviewed');
    if (!okStaff) return res.status(409).json({ error: 'STAFF_CHECK_REQUIRED', message: 'At least one named staff member needs a REVIEWED, unexpired background check before anyone checks in.' });
    const p = findPlayer(t.playerId);
    const minor = p && !isAdult(p);
    const requiredScope = minor ? 'guardian_event_consent' : 'player_event_consent';
    if (!t.day.consents.some((c) => c.scope === requiredScope)) {
      return res.status(409).json({ error: 'CONSENT_REQUIRED', scope: requiredScope, message: minor ? 'The guardian has not given event consent for this trial day.' : 'The player has not given event consent for this trial day.' });
    }
    if (t.day.checkins.some((c) => c.playerId === t.playerId)) return res.status(409).json({ error: 'ALREADY_CHECKED_IN' });
    const checkedInAt = Date.now();
    t.day.checkins.push({ playerId: t.playerId, at: checkedInAt, byUserId: req.orgUser.id, byName: req.orgUser.name });
    // M23 P4B (D-8): a check-in is the strongest attendance source. If the
    // trial carries a confirmed P4B schedule, the session whose window holds
    // this moment (from two hours before its start) gets an `attended`
    // record with source `checkin` — once, append-only, never a judgement.
    // A trial without a P4B schedule records nothing new here.
    const sessions = Array.isArray(t.schedule?.sessions) && t.schedule?.confirmedAt ? t.schedule.sessions : [];
    const live = sessions.find((s) => s.startsAt - 2 * 3600_000 <= checkedInAt && checkedInAt <= s.endsAt) ?? null;
    if (live && !(t.attendance ?? []).some((a) => a.sessionId === live.id && a.state === 'attended')) {
      t.attendance ??= [];
      t.attendance.push({ sessionId: live.id, state: 'attended', source: 'checkin', recordedBy: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name }, recordedAt: checkedInAt, note: null });
      t.history ??= [];
      t.history.push({ id: nextId('aud'), at: checkedInAt, action: 'trial_attendance_recorded', by: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name }, detail: { sessionId: live.id, state: 'attended', source: 'checkin' } });
      t.rev = (Number(t.rev) || 1) + 1; t.revAt = checkedInAt; t.revBy = { userId: req.orgUser.id, name: req.orgUser.name };
    }
    // Feed the existing attendance record — once, coach-signed, no duplicate.
    if (p && !(p.attendance ?? []).some((a) => a.trialId === t.id)) {
      p.attendance.push({
        id: nextId('att'), trialId: t.id, fixture: `Trial day · ${t.orgName}`,
        venue: t.venue ?? '', date: t.proposedDate ?? new Date().toISOString().slice(0, 10),
        gps: null, verified: true, corroboratedBy: t.orgName,
      });
      recordActivity(p);
    }
    ledgerAppend({ type: 'trial_checkin', playerId: t.playerId, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    persistNow();
    res.json({ trial: trialDayView(t, 'org') });
  });

  // Player/guardian side: consent, restricted emergency info, safety pack.
  function playerTrial(req, res, playerIds) {
    const t = db.trials.find((x) => x.id === req.params.id && playerIds.includes(x.playerId));
    if (!t) { res.status(404).json({ error: 'TRIAL_NOT_FOUND' }); return null; }
    t.day ??= { staff: [], consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [] };
    return t;
  }

  function giveConsent(req, res, t, by, scope) {
    if (t.day.consents.some((c) => c.scope === scope && c.by.id === by.id)) return res.status(409).json({ error: 'ALREADY_CONSENTED' });
    t.day.consents.push({ id: nextId('cns'), by, scope, at: Date.now() });
    persistNow();
    res.status(201).json({ consented: scope });
  }

  playerRouter.post('/trials/:id/consent', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Event consent for under-18s comes from the guardian.' });
    const t = playerTrial(req, res, [req.player.id]);
    if (t) giveConsent(req, res, t, { kind: 'player', id: req.player.id, name: req.player.name }, 'player_event_consent');
  });

  guardianRouter.post('/trials/:id/consent', (req, res) => {
    const t = playerTrial(req, res, req.guardian.childIds);
    if (t) giveConsent(req, res, t, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name }, 'guardian_event_consent');
  });

  function setEmergency(req, res, t, by) {
    const { name, phone } = req.body ?? {};
    if (!name || !phone) return res.status(400).json({ error: 'NAME_AND_PHONE_REQUIRED' });
    // Restricted: written by the family, readable ONLY in the org's trial-day
    // view for the named event. Never in profiles, search or exports.
    t.day.emergency = { name: String(name).slice(0, 80), phone: String(phone).slice(0, 30), setBy: by, at: Date.now() };
    persistNow();
    res.json({ ok: true, note: 'Held for this event’s safety staff only.' });
  }
  playerRouter.post('/trials/:id/emergency-contact', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED' });
    const t = playerTrial(req, res, [req.player.id]);
    if (t) setEmergency(req, res, t, 'player');
  });
  guardianRouter.post('/trials/:id/emergency-contact', (req, res) => {
    const t = playerTrial(req, res, req.guardian.childIds);
    if (t) setEmergency(req, res, t, 'guardian');
  });

  function safetyPack(t, forGuardian) {
    return {
      trial: trialDayView(t, 'family'),
      pack: {
        staff: trialDayView(t, 'family').staff,
        headline: 'Who will be there, what has been checked, and what to do if something feels wrong.',
        checksExplained: 'A "reviewed" check means Trust & Safety examined the club’s filed reference for that person. "Pending" means it has NOT been examined yet. We show you the truth rather than a badge.',
        arrival: t.day.arrival,
        collection: forGuardian ? t.day.collection : null,
        emergencySet: !!t.day.emergency,
        reportRoute: 'Anything concerning: use ⚑ Report in the app — urgent reports suspend club communication immediately.',
        feedbackDue: Number.isFinite(t.reportDueAt) ? new Date(t.reportDueAt).toISOString().slice(0, 10) : null,
      },
    };
  }

  // The family's list of their own trials (safety pack entry point).
  const familyTrials = (playerIds, { minorDevice = false } = {}) => db.trials
    .filter((t) => t && typeof t === 'object' && playerIds.includes(t.playerId))
    .map((t) => {
      t.day ??= { staff: [], consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [] };
      // P4B: the workflow edge (state, confirmed sessions, completion) rides
      // beside the P2 day view. Family view only — never the club's internals.
      // A minor's own device carries the guardian-managed OUTCOME LINE only
      // (privacy matrix §112): never the sessions, the address, the
      // instructions or the history the guardian holds.
      return { ...trialDayView(t, 'family'), workflow: minorDevice ? trialOutcomeLine(t) : trialFamilyView(t) };
    });
  playerRouter.get('/trials', (req, res) => res.json(familyTrials([req.player.id], { minorDevice: !!req.playerIsMinor })));
  guardianRouter.get('/trials', (req, res) => res.json(familyTrials(req.guardian.childIds)));

  playerRouter.get('/trials/:id/safety-pack', (req, res) => {
    const t = playerTrial(req, res, [req.player.id]);
    if (t) res.json(safetyPack(t, false));
  });
  guardianRouter.get('/trials/:id/safety-pack', (req, res) => {
    const t = playerTrial(req, res, req.guardian.childIds);
    if (t) res.json(safetyPack(t, true));
  });

  // Admin review queue for staff checks — jurisdiction-appropriate wording,
  // honest states, nothing auto-approved.
  adminRouter.get('/staff-checks', (req, res) => {
    const rows = db.trials.flatMap((t) => (t.day?.staff ?? []).filter((s) => s.check).map((s) => ({ trialId: t.id, orgId: t.orgId, orgName: t.orgName, staffId: s.id, name: s.name, role: s.role, check: { ...s.check, state: checkState(s.check) } })));
    res.json(paginate(req, rows.filter((r) => req.query.all === '1' || r.check.status === 'pending')));
  });

  adminRouter.post('/staff-checks/:trialId/:staffId', (req, res) => {
    const t = db.trials.find((x) => x.id === req.params.trialId);
    const s = t?.day?.staff.find((x) => x.id === req.params.staffId);
    if (!s?.check) return res.status(404).json({ error: 'CHECK_NOT_FOUND' });
    const { status, expiresAt } = req.body ?? {};
    if (!['reviewed', 'rejected'].includes(status)) return res.status(400).json({ error: 'STATUS_INVALID', allowed: ['reviewed', 'rejected'] });
    s.check.status = status;
    s.check.reviewedBy = 'Trust & Safety';
    s.check.reviewedAt = Date.now();
    if (expiresAt) s.check.expiresAt = expiresAt;
    persistNow();
    res.json({ check: { ...s.check, state: checkState(s.check) } });
  });
}
