// F5 — Structured opportunity board · F6 — Club-run assessment campaigns ·
// F8 — Feedback → development → reassessment · F9 — Trial-day experience.
//
// Everything guardian-routed for minors, everything eligibility-checked
// server-side (fail-closed on missing location), grassroots 50 km preserved.

import { GRASSROOTS_RADIUS_KM, parseTrialDate, trialReportDueAt } from '../../domain.mjs';
import { parseStrictDateOnly, parseDateOrInstant, isExpiredAt, isAbsent } from '../../temporal.mjs';
import { trialFamilyView, trialOutcomeLine } from '../recruitment/lifecycle/trial.mjs';
import { readPage, sendPageError, pageOf, offsetPage } from '../platform/paging.mjs';
import { OPPORTUNITY_TYPES, OPPORTUNITY_CATEGORIES, OPPORTUNITIES_CAMPAIGNS_LIMITS as OL, FILE_CHECK_ISSUES, typeEligibility } from '../../repositories/opportunitiesCampaigns.mjs';
import { storedName } from './passport.mjs';

// Responses are built from explicit allowlists, never by spreading a stored record.
const eligibilityView = (e) => ({ minAge: e.minAge, maxAge: e.maxAge, positionGroup: e.positionGroup, ...(e.category !== undefined ? { category: e.category } : {}), maxLevel: e.maxLevel, radiusKm: e.radiusKm });
const slotView = (s) => ({ day: s.day, start: s.start, end: s.end, tz: s.tz });
export const opportunityView = (o) => ({
  id: o.id, orgId: o.orgId, orgName: o.orgName, orgLevel: o.orgLevel, type: o.type, title: o.title, team: o.team, category: o.category,
  ageGroup: o.ageGroup, role: o.role, description: o.description, schedule: o.schedule, deadline: o.deadline, capacity: o.capacity,
  eligibility: eligibilityView(o.eligibility), requirements: [...o.requirements], status: o.status, createdBy: o.createdBy, createdAt: o.createdAt, closedAt: o.closedAt,
  structured: o.structured ? { trainingSlots: o.structured.trainingSlots.map(slotView), relocationRequired: o.structured.relocationRequired, feeMinor: o.structured.feeMinor, currency: o.structured.currency, expensesCovered: o.structured.expensesCovered, environment: [...o.structured.environment], accommodations: [...o.structured.accommodations] } : null,
});
const historyView = (h) => ({ id: h.id, at: h.at, byKind: h.byKind, byId: h.byId, byName: h.byName, action: h.action, detail: h.detail });
export const applicationView = (a) => ({
  id: a.id, opportunityId: a.opportunityId, orgId: a.orgId, playerId: a.playerId, playerName: a.playerName,
  submittedBy: { kind: a.submittedBy.kind, id: a.submittedBy.id, name: a.submittedBy.name }, note: a.note, status: a.status,
  outcome: a.outcome ? { decision: a.outcome.decision, note: a.outcome.note, byUserId: a.outcome.byUserId, byName: a.outcome.byName, at: a.outcome.at } : null,
  createdAt: a.createdAt, remindedAt: a.remindedAt,
  suitabilitySummary: a.suitabilitySummary ? { approvedAt: a.suitabilitySummary.approvedAt, approvedBy: a.suitabilitySummary.approvedBy, verdicts: a.suitabilitySummary.verdicts.map((v) => ({ dimension: v.dimension, verdict: v.verdict })) } : null,
  history: a.history.map(historyView),
});
const campaignView = (c) => ({
  id: c.id, orgId: c.orgId, orgName: c.orgName, title: c.title,
  drills: c.drills.map((d) => ({ name: d.name, instructions: d.instructions, recording: { equipment: d.recording.equipment, distance: d.recording.distance, surface: d.recording.surface, camera: d.recording.camera } })),
  deadline: c.deadline, attemptsAllowed: c.attemptsAllowed, eligibility: eligibilityView(c.eligibility), rubric: c.rubric.map((r) => ({ criterion: r.criterion, guidance: r.guidance })),
  status: c.status, createdBy: c.createdBy, createdAt: c.createdAt,
});
const attemptView = (a) => ({
  id: a.id, mediaId: a.mediaId, drillName: a.drillName, note: a.note,
  fileChecks: { passed: a.fileChecks.passed, issues: [...a.fileChecks.issues], checkedAt: a.fileChecks.checkedAt, kind: a.fileChecks.kind }, status: a.status,
  review: a.review ? { byUserId: a.review.byUserId, byName: a.review.byName, at: a.review.at, kind: a.review.kind, reasons: a.review.reasons, rubricNotes: a.review.rubricNotes } : null,
  submittedAt: a.submittedAt,
});
const submissionView = (s) => ({
  id: s.id, campaignId: s.campaignId, orgId: s.orgId, playerId: s.playerId, playerName: s.playerName,
  submittedBy: { kind: s.submittedBy.kind, id: s.submittedBy.id, name: s.submittedBy.name }, attempts: s.attempts.map(attemptView), createdAt: s.createdAt,
});

export function registerJourneys(ctx) {
  const {
    db, byId, scoutingReads, nextId, persistNow, notify, ledgerAppend, broadcast, findPlayer,
    orgRouter, playerRouter, guardianRouter, adminRouter,
    orgCanSee, paginate, audit, requireLead, isLead, moderateOrRefuse, isAdult,
    checkEligibility, distanceBand, guardianOwnsChild, recordActivity, DRILLS,
    players, users, unit, recruitment, opportunitiesCampaigns,
  } = ctx;
  if (typeof opportunitiesCampaigns?.opportunities?.create !== 'function') throw new TypeError('registerJourneys needs the opportunities and campaigns repository from the data layer');
  // S8a: a trial-day change is an explicit write of the trial (recruitment.trials.update); the records the views hand out are read-only.
  const trials = recruitment?.trials;
  if (!trials) throw new TypeError('registerJourneys needs the recruitment repository from the data layer');

  // ================================================================== F5
  // S9d: opportunities and applications are rows of the opportunities and campaigns repository
  // (repositories/opportunitiesCampaigns.mjs), written by explicit operations and read through SQL. Junk is refused with
  // the field named (400 FIELD_INVALID); over-long text is still shortened.
  const OPP_TYPES = OPPORTUNITY_TYPES;
  const fieldInvalid = (res, field, message) => { res.status(400).json({ error: 'FIELD_INVALID', field, message }); return undefined; };
  const optionalText = (v) => v === undefined || v === null || typeof v === 'string';
  const textOrNull = (v, max) => (v ? v.slice(0, max) : null);
  const today = () => new Date().toISOString().slice(0, 10);

  /**
   * The eligibility a club may set, typed, with the grassroots rules forced (amateur and semi-pro only, the 50 km
   * radius). Returns the record, or undefined after a 400.
   */
  function eligibilityOrRefuse(res, raw, org, { category } = {}) {
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) return fieldInvalid(res, 'eligibility', 'eligibility is an object.');
    const e = raw ?? {};
    const known = ['minAge', 'maxAge', 'positionGroup', 'maxLevel', 'radiusKm', ...(category === undefined ? [] : ['category'])];
    const extra = Object.keys(e).find((k) => !known.includes(k));
    if (extra) return fieldInvalid(res, `eligibility.${extra}`, `eligibility has no field ${extra}.`);
    const grassroots = org.level === 'grassroots';
    const record = {
      minAge: e.minAge ?? null, maxAge: e.maxAge ?? null, positionGroup: e.positionGroup ?? 'any',
      ...(category === undefined ? {} : { category: ['mens', 'womens', 'boys', 'girls'].includes(category) ? category : 'mixed' }),
      maxLevel: grassroots ? 'semi_pro' : (e.maxLevel ?? null),
      // The 50 km rule is not optional for grassroots orgs.
      radiusKm: grassroots ? GRASSROOTS_RADIUS_KM : (e.radiusKm ?? null),
    };
    const t = typeEligibility(record, 'eligibility', { withCategory: category !== undefined });
    if (!t.ok) { const field = /eligibility\.(\w+)/.exec(t.reason)?.[1]; return fieldInvalid(res, field ? `eligibility.${field}` : 'eligibility', `eligibility: ${t.reason.replace(/^eligibility\./, '')}.`); }
    return t.record;
  }

  orgRouter.post('/opportunities', (req, res) => {
    const b = req.body ?? {};
    if (!OPP_TYPES.includes(b.type)) return res.status(400).json({ error: 'TYPE_INVALID', allowed: OPP_TYPES });
    if (typeof b.title !== 'string' || !b.title.trim()) return res.status(400).json({ error: 'TITLE_REQUIRED' });
    if (!b.deadline) return res.status(400).json({ error: 'DEADLINE_REQUIRED' });
    if (!parseStrictDateOnly(b.deadline).ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'deadline', message: 'A deadline is a calendar day written YYYY-MM-DD.', expected: 'YYYY-MM-DD' });
    for (const f of ['team', 'ageGroup', 'role', 'description', 'schedule']) if (!optionalText(b[f])) return fieldInvalid(res, f, `${f} is text.`);
    if (b.category !== undefined && b.category !== null && !OPPORTUNITY_CATEGORIES.includes(b.category)) return fieldInvalid(res, 'category', `category is one of ${OPPORTUNITY_CATEGORIES.join(', ')}.`);
    if (b.capacity !== undefined && b.capacity !== null && !(Number.isSafeInteger(b.capacity) && b.capacity >= 1)) return fieldInvalid(res, 'capacity', 'capacity is a whole number of places (1 or more), or null for no limit.');
    if (b.requirements !== undefined && b.requirements !== null && (!Array.isArray(b.requirements) || b.requirements.length > OL.requirements || b.requirements.some((r) => typeof r !== 'string' || !r.trim()))) return fieldInvalid(res, 'requirements', `requirements is a list of at most ${OL.requirements} lines of text.`);
    if (b.description && !moderateOrRefuse(res, b.description, { kind: 'opportunity', orgId: req.org.id })) return;
    const category = b.category ?? 'mixed';
    const eligibility = eligibilityOrRefuse(res, b.eligibility, req.org, { category });
    if (!eligibility) return;
    const opp = opportunitiesCampaigns.opportunities.create({
      id: nextId('opp'), orgId: req.org.id, orgName: storedName(req.org.name), orgLevel: req.org.level ?? 'pro',
      type: b.type, title: b.title.slice(0, OL.title), team: textOrNull(b.team, OL.team), category,
      ageGroup: textOrNull(b.ageGroup, OL.ageGroup), role: textOrNull(b.role, OL.role), description: textOrNull(b.description, OL.description),
      schedule: textOrNull(b.schedule, OL.schedule), deadline: b.deadline, capacity: b.capacity ?? null, eligibility,
      requirements: (b.requirements ?? []).map((r) => r.slice(0, OL.requirement)),
      status: 'published', createdBy: storedName(req.orgUser.name), createdAt: Date.now(), closedAt: null, structured: null,
    });
    broadcast('opportunities', {});
    res.status(201).json({ opportunity: opportunityView(opp) });
  });

  const oppOpen = (o) => o.status === 'published' && o.deadline >= today();

  // §4.3: a club's opportunities grow without limit (they are closed, never deleted), so the list pages, newest first.
  orgRouter.get('/opportunities', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const { items, nextCursor } = pageOf(scoutingReads.opportunities.page(req.org.id, page).rows, page.limit, (r) => r.key);
    const counts = scoutingReads.opportunities.applicationCounts(items.map((r) => r.opportunity.id));
    res.json({ items: items.map((r) => ({ ...opportunityView(r.opportunity), open: oppOpen(r.opportunity), ...counts[r.opportunity.id] })), nextCursor });
  });

  // M23 P5.6B: the board is a pure module-level function so the Agent
  // workspace can project a confirmed client's board through exactly the
  // same eligibility and mutual-visibility rules — one engine, not two.
  const boardFor = (player) => opportunityBoardFor(db, player, { orgCanSee, checkEligibility, distanceBand, scoutingReads, orgOf: byId.org });

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
    const o = scoutingReads.opportunities.byId(req.params.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    if (!oppOpen(o)) return res.status(409).json({ error: 'OPPORTUNITY_CLOSED' });
    const org = byId.org(o.orgId);
    if (!org || !orgCanSee(org, player)) return res.status(403).json({ error: 'NOT_ELIGIBLE', reasons: ['this club cannot work with this profile'] });
    const { eligible, reasons } = checkEligibility(o.eligibility, player, org);
    if (!eligible) return res.status(403).json({ error: 'NOT_ELIGIBLE', reasons });
    if (scoutingReads.applications.liveFor(o.id, player.id)) return res.status(409).json({ error: 'ALREADY_APPLIED' });
    if (o.capacity && scoutingReads.opportunities.applicationCounts([o.id])[o.id].applications >= o.capacity) {
      return res.status(409).json({ error: 'CAPACITY_FULL' });
    }
    if (!optionalText(req.body?.note)) return fieldInvalid(res, 'note', 'note is text.');
    const note = textOrNull(req.body?.note, OL.note);
    if (note && !moderateOrRefuse(res, note, { kind: 'application', playerId: player.id, orgId: o.orgId })) return;
    const at = Date.now();
    // ONE unit of work: the application, its ledger row and the club's notification commit together.
    const appn = unit(() => {
      const created = opportunitiesCampaigns.applications.create({
        id: nextId('apl'), opportunityId: o.id, orgId: o.orgId, playerId: player.id, playerName: storedName(player.name),
        submittedBy: { kind: submitter.kind, id: submitter.id, name: storedName(submitter.name) }, note, status: 'submitted', outcome: null,
        createdAt: at, remindedAt: null, suitabilitySummary: null,
        history: [historyEntry(submitter.kind, submitter.id, submitter.name, 'submitted', at)],
      });
      ledgerAppend({ type: 'opportunity_application', playerId: player.id, orgId: o.orgId, orgName: o.orgName, userId: null, scoutName: submitter.name });
      notify({ kind: 'org_user', id: usersOf(o.orgId)[0]?.id ?? '' }, 'application', `📥 ${player.name} applied to "${o.title}".`, created.id);
      return created;
    });
    broadcast('applications', { playerId: player.id });
    res.status(201).json({ application: applicationView(appn) });
  }
  const usersOf = (orgId) => users.listByOrg(orgId).filter((u) => !u.removedAt);
  /** One history entry in the shared shape (detail is plain text or null). */
  const historyEntry = (byKind, byId_, byName, action, at = Date.now()) => ({ id: nextId('aud'), at, byKind, byId: byId_, byName: storedName(byName), action, detail: null });

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

  // A player's (or a guardian's children's) applications: a per-player list, not paged.
  function myApplications(playerIds) {
    const list = scoutingReads.applications.forPlayers(playerIds);
    const opps = new Map();
    for (const a of list) if (!opps.has(a.opportunityId)) opps.set(a.opportunityId, scoutingReads.opportunities.byId(a.opportunityId));
    return list.map((a) => {
      const o = opps.get(a.opportunityId);
      return { ...applicationView(a), opportunity: o ? { id: o.id, title: o.title, orgName: o.orgName, type: o.type, deadline: o.deadline } : {} };
    });
  }
  playerRouter.get('/applications', (req, res) => res.json(myApplications([req.player.id])));
  guardianRouter.get('/applications', (req, res) => res.json(myApplications(req.guardian.childIds)));

  function withdrawApplication(req, res, allowedPlayerIds, actor) {
    const a = scoutingReads.applications.ofPlayers(req.params.id, allowedPlayerIds);
    if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
    if (a.status !== 'submitted') return res.status(409).json({ error: 'NOT_WITHDRAWABLE', status: a.status });
    // S9d: a guardian's withdrawal is recorded as the guardian's (it used to be audited as the player's).
    const withdrawn = opportunitiesCampaigns.applications.update(a.id, (d) => { d.status = 'withdrawn'; d.history.push(historyEntry(actor.kind, actor.id, actor.name, 'withdrawn')); });
    res.json({ application: applicationView(withdrawn) });
  }
  playerRouter.post('/applications/:id/withdraw', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED' });
    withdrawApplication(req, res, [req.player.id], { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.post('/applications/:id/withdraw', (req, res) => withdrawApplication(req, res, req.guardian.childIds, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name }));

  // One opportunity's applications: offset paging (the apps' shape), in SQL.
  orgRouter.get('/opportunities/:id/applications', (req, res) => {
    const o = scoutingReads.opportunities.ofOrg(req.params.id, req.org.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    const { limit, offset } = offsetPage(req);
    const { total, items } = scoutingReads.applications.pageForOpportunity(o.id, { limit, offset });
    res.json({ total, limit, offset, items: items.map(applicationView) });
  });

  orgRouter.post('/applications/:id/outcome', (req, res) => {
    const a = scoutingReads.applications.ofOrg(req.params.id, req.org.id);
    if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
    if (a.outcome) return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    if (a.status === 'withdrawn') return res.status(409).json({ error: 'WITHDRAWN' });
    const { decision, note } = req.body ?? {};
    if (!['accepted', 'declined'].includes(decision)) return res.status(400).json({ error: 'DECISION_INVALID' });
    if (!optionalText(note)) return fieldInvalid(res, 'note', 'note is text.');
    if (note && !moderateOrRefuse(res, note, { kind: 'application_outcome', playerId: a.playerId, orgId: req.org.id })) return;
    const at = Date.now();
    const p = findPlayer(a.playerId);
    const title = scoutingReads.opportunities.byId(a.opportunityId)?.title;
    const resolved = unit(() => {
      const fresh = opportunitiesCampaigns.applications.update(a.id, (d) => {
        d.status = decision;
        d.outcome = { decision, note: textOrNull(note, OL.outcomeNote), byUserId: req.orgUser.id, byName: storedName(req.orgUser.name), at };
        d.history.push(historyEntry('org', req.orgUser.id, req.orgUser.name, decision, at));
      });
      const text = decision === 'accepted'
        ? `✅ ${req.org.name} accepted the application to "${title}". They'll follow up through ScoutBox.`
        : `${req.org.name} on your application: ${fresh.outcome.note ?? 'not this time — keep playing, keep logging.'}`;
      if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'application', text, a.id);
      else if (p) notify({ kind: 'player', id: p.id }, 'application', text, a.id);
      return fresh;
    });
    broadcast('applications', { playerId: a.playerId });
    res.json({ application: applicationView(resolved) });
  });

  // No-ghosting extends to the board: closing an opportunity with unresolved
  // applications is refused; the sweep (operations.mjs) nags outstanding ones.
  orgRouter.post('/opportunities/:id/close', (req, res) => {
    const o = scoutingReads.opportunities.ofOrg(req.params.id, req.org.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    const { outstanding } = scoutingReads.opportunities.applicationCounts([o.id])[o.id];
    if (outstanding) return res.status(409).json({ error: 'OUTCOMES_OUTSTANDING', count: outstanding, message: 'Every applicant gets an answer before the door closes.' });
    if (o.status === 'closed') return res.json({ opportunity: opportunityView(o) }); // closing twice keeps the first close
    const closed = opportunitiesCampaigns.opportunities.update(o.id, (d) => { d.status = 'closed'; d.closedAt = Date.now(); });
    res.json({ opportunity: opportunityView(closed) });
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

  /** A campaign's drills from a request: the recording defaults fill what is absent; wrong types are refused. */
  function drillsOrRefuse(res, drills) {
    if (drills.length > OL.drills) return fieldInvalid(res, 'drills', `a campaign has at most ${OL.drills} drills.`);
    const out = []; const names = new Set();
    for (const [i, d] of drills.entries()) {
      const at = `drills[${i}]`;
      if (!d || typeof d !== 'object' || Array.isArray(d)) return fieldInvalid(res, at, 'a drill is an object { name, instructions, recording }.');
      if (typeof d.name !== 'string' || !d.name.trim()) return fieldInvalid(res, `${at}.name`, 'every drill has a name.');
      if (!optionalText(d.instructions)) return fieldInvalid(res, `${at}.instructions`, 'instructions is text.');
      if (d.recording !== undefined && d.recording !== null && (typeof d.recording !== 'object' || Array.isArray(d.recording))) return fieldInvalid(res, `${at}.recording`, 'recording is an object.');
      const r = d.recording ?? {};
      for (const f of ['equipment', 'distance', 'surface', 'camera']) if (!optionalText(r[f])) return fieldInvalid(res, `${at}.recording.${f}`, `${f} is text.`);
      const name = d.name.slice(0, OL.drillName);
      if (names.has(name)) return fieldInvalid(res, `${at}.name`, `two drills are called "${name}".`);
      names.add(name);
      out.push({
        name, instructions: (d.instructions ?? '').slice(0, OL.instructions),
        recording: {
          equipment: (r.equipment ?? 'Any phone camera').slice(0, OL.recording), distance: (r.distance ?? 'Full area in frame').slice(0, OL.recording),
          surface: (r.surface ?? 'Flat grass/turf').slice(0, OL.recording), camera: (r.camera ?? 'Fixed, side-on').slice(0, OL.recording),
        },
      });
    }
    return out;
  }

  orgRouter.post('/campaigns', (req, res) => {
    const b = req.body ?? {};
    if (typeof b.title !== 'string' || !b.title.trim() || !Array.isArray(b.drills) || !b.drills.length) return res.status(400).json({ error: 'TITLE_AND_DRILLS_REQUIRED' });
    if (!b.deadline) return res.status(400).json({ error: 'DEADLINE_REQUIRED' });
    if (!parseStrictDateOnly(b.deadline).ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'deadline', message: 'A deadline is a calendar day written YYYY-MM-DD.', expected: 'YYYY-MM-DD' });
    const attemptsAllowed = b.attemptsAllowed ?? 2;
    if (!Number.isSafeInteger(attemptsAllowed) || attemptsAllowed < 1 || attemptsAllowed > OL.attemptsAllowed) return fieldInvalid(res, 'attemptsAllowed', `attemptsAllowed is a whole number from 1 to ${OL.attemptsAllowed}.`);
    const drills = drillsOrRefuse(res, b.drills);
    if (!drills) return;
    const rubricIn = b.rubric ?? [];
    if (!Array.isArray(rubricIn) || rubricIn.length > OL.rubric) return fieldInvalid(res, 'rubric', `rubric is a list of at most ${OL.rubric} criteria.`);
    const rubric = [];
    for (const [i, r] of rubricIn.entries()) {
      if (!r || typeof r !== 'object' || typeof r.criterion !== 'string' || !r.criterion.trim() || !optionalText(r.guidance)) return fieldInvalid(res, `rubric[${i}]`, 'a rubric line is { criterion, guidance } (text).');
      rubric.push({ criterion: r.criterion.slice(0, OL.criterion), guidance: (r.guidance ?? '').slice(0, OL.guidance) });
    }
    const eligibility = eligibilityOrRefuse(res, b.eligibility, req.org);
    if (!eligibility) return;
    const camp = opportunitiesCampaigns.campaigns.create({
      id: nextId('cmp'), orgId: req.org.id, orgName: storedName(req.org.name), title: b.title.slice(0, OL.title), drills, deadline: b.deadline,
      attemptsAllowed, eligibility, rubric, status: 'published', createdBy: storedName(req.orgUser.name), createdAt: Date.now(),
    });
    broadcast('campaigns', {});
    res.status(201).json({ campaign: campaignView(camp) });
  });

  // §4.3: a club's campaigns grow without limit (never deleted), so the list pages, newest first.
  orgRouter.get('/campaigns', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const { items, nextCursor } = pageOf(scoutingReads.campaigns.page(req.org.id, page).rows, page.limit, (r) => r.key);
    const counts = scoutingReads.campaigns.submissionCounts(items.map((r) => r.campaign.id));
    res.json({ items: items.map((r) => ({ ...campaignView(r.campaign), ...counts[r.campaign.id] })), nextCursor });
  });

  const campOpen = (c) => c.status === 'published' && c.deadline >= today();

  function campaignsFor(player) {
    const mine = new Map(scoutingReads.campaignSubmissions.forPlayer(player.id).map((s) => [s.campaignId, s]));
    return scoutingReads.campaigns.openOn(today()).map((c) => {
      const org = byId.org(c.orgId);
      if (!org || org.suspended || !orgCanSee(org, player)) return null;
      const { eligible } = checkEligibility(c.eligibility, player, org);
      if (!eligible) return null;
      const sub = mine.get(c.id);
      return { ...campaignView(c), mySubmission: sub ? submissionView(sub) : null };
    }).filter(Boolean);
  }

  playerRouter.get('/campaigns', (req, res) => res.json({ items: campaignsFor(req.player) }));
  guardianRouter.get('/children/:id/campaigns', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    res.json({ items: campaignsFor(child) });
  });

  // The automated tier: FILE checks only — the media exists, it is video,
  // it is inside the size cap. Says nothing about drill execution.
  function fileChecks(player, mediaId) {
    const issues = [];
    const media = mediaId ? player.media.find((m) => m.id === mediaId) : null;
    if (!media) issues.push(FILE_CHECK_ISSUES.media_missing);
    else {
      if (media.kind !== 'video') issues.push(FILE_CHECK_ISSUES.not_video);
      if (!media.url && !db.mediaBlobs?.[media.id] && !media.id.startsWith('media-seed')) {
        // url null AND no stored blob → metadata-only entry
        issues.push(FILE_CHECK_ISSUES.not_uploaded);
      }
    }
    return { passed: issues.length === 0, issues, checkedAt: Date.now(), kind: 'automated_file_check' };
  }

  function submitAttempt(req, res, player, submitter) {
    const camp = scoutingReads.campaigns.byId(req.params.id);
    if (!camp) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
    if (!campOpen(camp)) return res.status(409).json({ error: 'CAMPAIGN_CLOSED' });
    const org = byId.org(camp.orgId);
    const { eligible, reasons } = checkEligibility(camp.eligibility, player, org);
    if (!org || !orgCanSee(org, player) || !eligible) return res.status(403).json({ error: 'NOT_ELIGIBLE', reasons: reasons ?? [] });
    const existing = scoutingReads.campaignSubmissions.forCampaignPlayer(camp.id, player.id);
    // Only attempts that actually reached review (or passed it) count against
    // the policy — a failed FILE check never burns a football attempt.
    const activeAttempts = (existing?.attempts ?? []).filter((a) => ['submitted', 'accepted'].includes(a.status)).length;
    if (activeAttempts >= camp.attemptsAllowed) return res.status(409).json({ error: 'ATTEMPTS_EXHAUSTED', allowed: camp.attemptsAllowed });
    const { mediaId, drillName, note } = req.body ?? {};
    if (!optionalText(mediaId) || (mediaId && mediaId.length > 80)) return fieldInvalid(res, 'mediaId', 'mediaId is the id of one of the player\'s media items.');
    if (drillName !== undefined && drillName !== null && !camp.drills.some((d) => d.name === drillName)) return fieldInvalid(res, 'drillName', `drillName is one of this campaign's drills: ${camp.drills.map((d) => d.name).join(', ')}.`);
    if (!optionalText(note)) return fieldInvalid(res, 'note', 'note is text.');
    if ((existing?.attempts.length ?? 0) >= OL.attempts) return res.status(409).json({ error: 'ATTEMPTS_EXHAUSTED', allowed: camp.attemptsAllowed, message: 'This submission holds as many attempts as it can.' });
    if (note && !moderateOrRefuse(res, note, { kind: 'campaign_note', playerId: player.id, orgId: camp.orgId })) return;
    const checks = fileChecks(player, mediaId);
    const attempt = {
      id: nextId('att'), mediaId: mediaId || null, drillName: drillName ?? camp.drills[0].name,
      note: textOrNull(note, OL.note),
      fileChecks: checks,
      // Human review is a SEPARATE state — an attempt passing file checks is
      // "submitted", never "verified".
      status: checks.passed ? 'submitted' : 'failed_checks',
      review: null, submittedAt: Date.now(),
    };
    // ONE unit of work: the submission (created on the first attempt), the attempt and the club's notification.
    const sub = unit(() => {
      const s = existing
        ? opportunitiesCampaigns.submissions.update(existing.id, (d) => { d.attempts.push(attempt); })
        : opportunitiesCampaigns.submissions.create({ id: nextId('csb'), campaignId: camp.id, orgId: camp.orgId, playerId: player.id, playerName: storedName(player.name), submittedBy: { kind: submitter.kind, id: submitter.id, name: storedName(submitter.name) }, attempts: [attempt], createdAt: Date.now() });
      if (checks.passed) notify({ kind: 'org_user', id: usersOf(camp.orgId)[0]?.id ?? '' }, 'campaign', `🎬 ${player.name} submitted an attempt to "${camp.title}" — human review needed.`, s.id);
      return s;
    });
    const stored = sub.attempts.find((a) => a.id === attempt.id);
    res.status(201).json({ attempt: attemptView(stored), submission: submissionView(sub), note: checks.passed ? 'File checks passed. A coach still has to review the drill itself — that is a separate, human step.' : 'Automated file checks failed — fix the issues and resubmit.' });
  }

  playerRouter.post('/campaigns/:id/submit', (req, res) => {
    // Campaign attempts are football activity (like drills), so an eligible
    // minor may upload; all club-facing review conversation stays org↔guardian.
    submitAttempt(req, res, req.player, { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.post('/children/:childId/campaigns/:id/submit', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.childId)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.childId);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    submitAttempt(req, res, child, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  // One campaign's review queue: a per-campaign list, not paged.
  orgRouter.get('/campaigns/:id/review-queue', (req, res) => {
    const camp = scoutingReads.campaigns.ofOrg(req.params.id, req.org.id);
    if (!camp) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
    const queue = scoutingReads.campaignSubmissions.forCampaign(camp.id)
      .flatMap((s) => s.attempts.filter((a) => a.status === 'submitted').map((a) => ({ submissionId: s.id, playerId: s.playerId, playerName: s.playerName, attempt: { ...attemptView(a), mediaUrl: a.mediaId ? `/media/${a.mediaId}` : null } })));
    res.json({ campaign: { id: camp.id, title: camp.title, rubric: camp.rubric }, queue });
  });

  orgRouter.post('/campaign-attempts/:id/review', (req, res) => {
    const found = scoutingReads.campaignSubmissions.byAttempt(req.params.id);
    const sub = found && found.orgId === req.org.id ? found : null;
    const attempt = sub?.attempts.find((a) => a.id === req.params.id);
    if (!attempt) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    if (attempt.status !== 'submitted') return res.status(409).json({ error: 'NOT_REVIEWABLE', status: attempt.status });
    const { decision, reasons, rubricNotes } = req.body ?? {};
    if (!['accepted', 'returned'].includes(decision)) return res.status(400).json({ error: 'DECISION_INVALID' });
    if (!optionalText(reasons)) return fieldInvalid(res, 'reasons', 'reasons is text.');
    if (!optionalText(rubricNotes)) return fieldInvalid(res, 'rubricNotes', 'rubricNotes is text.');
    if (decision === 'returned' && (!reasons || !reasons.trim())) {
      return res.status(400).json({ error: 'REASONS_REQUIRED', message: 'A returned attempt tells the player exactly what to fix and how to resubmit.' });
    }
    if (reasons && !moderateOrRefuse(res, reasons, { kind: 'campaign_review', playerId: sub.playerId, orgId: req.org.id })) return;
    const p = findPlayer(sub.playerId);
    const camp = scoutingReads.campaigns.byId(sub.campaignId);
    const reviewed = unit(() => {
      const fresh = opportunitiesCampaigns.submissions.update(sub.id, (d) => {
        const a = d.attempts.find((x) => x.id === attempt.id);
        a.status = decision;
        a.review = { byUserId: req.orgUser.id, byName: storedName(req.orgUser.name), at: Date.now(), kind: 'human_review', reasons: textOrNull(reasons, OL.reasons), rubricNotes: textOrNull(rubricNotes, OL.rubricNotes) };
      }).attempts.find((x) => x.id === attempt.id);
      const text = decision === 'accepted'
        ? `✅ Your "${camp?.title}" attempt was reviewed and accepted by ${req.org.name}.`
        : `↩️ ${req.org.name} returned your "${camp?.title}" attempt: ${fresh.review.reasons} — you can resubmit.`;
      if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'campaign', `${p.name}: ${text}`, sub.id);
      if (p) notify({ kind: 'player', id: p.id }, 'campaign', text, sub.id);
      if (p && decision === 'accepted') recordActivity(p);
      return fresh;
    });
    res.json({ attempt: attemptView(reviewed) });
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
    const found = typeof feedbackId === 'string' ? ctx.scoutingReads.assessments.byId(feedbackId) : null;
    const a = found && found.playerId === player.id && found.publishedFeedback ? found : null;
    if (!a) return res.status(404).json({ error: 'PUBLISHED_FEEDBACK_NOT_FOUND', message: 'Objectives grow from feedback a club chose to publish — private assessments cannot seed them.' });
    if (!Array.isArray(objectives) || objectives.length < 1 || objectives.length > 2) {
      return res.status(400).json({ error: 'ONE_OR_TWO_OBJECTIVES', message: 'One or two focused objectives — not a laundry list.' });
    }
    const rec = {
      id: nextId('obj'), playerId: player.id, sourceFeedbackId: a.id, orgId: a.orgId,
      reviewer: { userId: a.publishedFeedback.byUserId, name: a.publishedFeedback.byName, orgName: byId.org(a.orgId)?.name },
      objectives: objectives.map((o) => ({
        id: nextId('objx'), text: String(o.text ?? '').slice(0, 200),
        exerciseRefs: Array.isArray(o.exerciseRefs) ? o.exerciseRefs.slice(0, 4) : [],
        baselineEvidenceIds: (Array.isArray(o.baselineEvidenceIds) ? o.baselineEvidenceIds : []).filter((id) => scoutingReads.evidence.byId(id)?.playerId === player.id),
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
    if (evidenceId && scoutingReads.evidence.byId(evidenceId)?.playerId !== req.player.id) return res.status(400).json({ error: 'EVIDENCE_INVALID' });
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
      evidenceIds: (Array.isArray(evidenceIds) ? evidenceIds : []).filter((id) => scoutingReads.evidence.byId(id)?.playerId === o.playerId),
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

  function trialFor(req, res) {
    const found = trials.byId(req.params.id);
    const t = found && found.orgId === req.org.id ? found : null;
    if (!t) { res.status(404).json({ error: 'TRIAL_NOT_FOUND' }); return null; }
    // M23 P4A-D14: a tombstoned trial (its subject removed their account) can
    // still be READ — the record of what happened is the club's — but nothing
    // new is written about a person who left.
    if (t.subjectRemovedAt && req.method !== 'GET') {
      res.status(409).json({ error: 'TRIAL_SUBJECT_REMOVED', message: 'This player removed their ScoutBox account. The trial stays on record; it can no longer be changed.' });
      return null;
    }
    return t; // S8a: every trial reads back with its trial-day container
  }

  orgRouter.get('/trials/:id/day', (req, res) => {
    const t = trialFor(req, res);
    if (t) res.json({ trial: trialDayView(t, 'org') });
  });

  /**
   * M23 P5.7 (T-2): a REVIEWED background check whose expiry cannot be read
   * used to read `reviewed` for ever (`NaN < now` is false). A check nobody
   * can date is not a current check: it reads `expired`, which is the state
   * the trial-day gate refuses. A missing expiry stays "no expiry recorded".
   */
  function checkState(c, now = Date.now()) {
    if (!c) return 'missing';
    if (c.status === 'reviewed' && !isAbsent(c.expiresAt) && isExpiredAt(readCheckExpiry(c.expiresAt), now)) return 'expired';
    return c.status;
  }
  /** A stored check expiry — a DATE_ONLY (valid through that day) or an instant — as the first instant it no longer holds; NaN when unreadable. */
  function readCheckExpiry(v) {
    const p = parseDateOrInstant(v, { dayEdge: 'end' });
    return p.ok ? p.ms : NaN;
  }
  /** Validate a check expiry from a request. Returns the canonical stored value, or a 400 already sent. */
  function checkExpiryOrRefuse(res, raw) {
    if (isAbsent(raw)) return null;
    const p = parseDateOrInstant(raw, { dayEdge: 'end' });
    if (!p.ok) { res.status(400).json({ error: 'DATE_INVALID', field: 'expiresAt', message: `A check expiry is a calendar day (YYYY-MM-DD) or an ISO 8601 date-time with an offset (${p.why}).`, expected: p.expected }); return undefined; }
    return p.precision === 'day' ? p.value : new Date(p.ms).toISOString();
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
    const expiresAt = check ? checkExpiryOrRefuse(res, check.expiresAt) : null;
    if (expiresAt === undefined) return;
    const s = {
      id: nextId('stf'), name: String(name).slice(0, 80), role: String(role).slice(0, 60),
      check: check ? {
        kind: String(check.kind ?? 'DBS (England & Wales)').slice(0, 60),
        ref: check.ref ? String(check.ref).slice(0, 60) : null,
        // Filing a reference does NOT make it reviewed — Trust & Safety (or
        // the club's safeguarding officer via T&S) moves it to 'reviewed'.
        status: 'pending',
        expiresAt,
        reviewedBy: null,
      } : null,
      addedBy: req.orgUser.name, addedAt: Date.now(),
    };
    trials.update(t.id, (d) => { d.day.staff.push(s); });
    res.status(201).json({ staff: s, note: 'The check is PENDING until Trust & Safety reviews it — an uploaded reference is not a completed background check.' });
  });

  orgRouter.post('/trials/:id/arrival', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    const { time, address, notes, collection } = req.body ?? {};
    if (notes && !moderateOrRefuse(res, notes, { kind: 'trial_arrival', playerId: t.playerId, orgId: req.org.id })) return;
    const fresh = trials.update(t.id, (d) => {
      d.day.arrival = { time: time ? String(time).slice(0, 40) : null, address: address ? String(address).slice(0, 200) : null, notes: notes ? String(notes).slice(0, 300) : null };
      if (collection) d.day.collection = { policy: String(collection).slice(0, 300) };
    });
    notifyTrialParties(fresh, `📍 ${fresh.orgName} published arrival details for the trial on ${fresh.proposedDate ?? 'TBC'}.`);
    res.json({ trial: trialDayView(fresh, 'org') });
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
    const fresh = trials.update(t.id, (d) => {
      d.day.statusEvents.push({ kind, at: Date.now(), by: req.orgUser.name, reason: String(reason).slice(0, 200), newDate: moved.value });
      if (kind === 'postponed' && moved.value) {
        d.proposedDate = moved.value;
        d.reportDueAt = trialReportDueAt(moved.value, d.acceptedAt);
      }
    });
    notifyTrialParties(fresh, kind === 'cancelled'
      ? `❌ ${fresh.orgName} cancelled the trial: ${reason}`
      : `📅 ${fresh.orgName} moved the trial to ${newDate ?? 'a new date TBC'}: ${reason}`);
    res.json({ trial: trialDayView(fresh, 'org') });
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
    // ONE unit of work (S5): the check-in and the attendance records on the
    // trial (a blob), the player's attendance row and activity, and the ledger
    // row commit together before the response.
    const fresh = unit(() => {
    const checkedIn = trials.update(t.id, (d) => {
    d.day.checkins.push({ playerId: d.playerId, at: checkedInAt, byUserId: req.orgUser.id, byName: req.orgUser.name });
    // M23 P4B (D-8): a check-in is the strongest attendance source. If the
    // trial carries a confirmed P4B schedule, the session whose window holds
    // this moment (from two hours before its start) gets an `attended`
    // record with source `checkin` — once, append-only, never a judgement.
    // A trial without a P4B schedule records nothing new here.
    const sessions = d.schedule?.confirmedAt ? d.schedule.sessions : [];
    const live = sessions.find((s) => s.startsAt - 2 * 3600_000 <= checkedInAt && checkedInAt <= s.endsAt) ?? null;
    if (live && !d.attendance.some((a) => a.sessionId === live.id && a.state === 'attended')) {
      d.attendance.push({ sessionId: live.id, state: 'attended', source: 'checkin', recordedBy: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name }, recordedAt: checkedInAt, note: null });
      d.history.push({ id: nextId('aud'), at: checkedInAt, action: 'trial_attendance_recorded', by: { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name }, detail: { sessionId: live.id, state: 'attended', source: 'checkin' } });
      d.rev = (Number(d.rev) || 1) + 1; d.revAt = checkedInAt; d.revBy = { userId: req.orgUser.id, name: req.orgUser.name };
    }
    });
    // Feed the existing attendance record — once, coach-signed, no duplicate.
    if (p && !(p.attendance ?? []).some((a) => a.trialId === t.id)) {
      players.addItem(p.id, 'attendance', {
        id: nextId('att'), trialId: t.id, fixture: `Trial day · ${t.orgName}`,
        venue: t.venue ?? '', date: t.proposedDate ?? new Date().toISOString().slice(0, 10),
        gps: null, verified: true, corroboratedBy: t.orgName,
      });
      recordActivity(p);
    }
    ledgerAppend({ type: 'trial_checkin', playerId: t.playerId, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    return checkedIn;
    });
    res.json({ trial: trialDayView(fresh, 'org') });
  });

  // Player/guardian side: consent, restricted emergency info, safety pack.
  function playerTrial(req, res, playerIds) {
    const found = trials.byId(req.params.id);
    const t = found && playerIds.includes(found.playerId) ? found : null;
    if (!t) { res.status(404).json({ error: 'TRIAL_NOT_FOUND' }); return null; }
    return t; // S8a: every trial reads back with its trial-day container
  }

  function giveConsent(req, res, t, by, scope) {
    if (t.day.consents.some((c) => c.scope === scope && c.by.id === by.id)) return res.status(409).json({ error: 'ALREADY_CONSENTED' });
    trials.update(t.id, (d) => { d.day.consents.push({ id: nextId('cns'), by, scope, at: Date.now() }); });
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
    trials.update(t.id, (d) => { d.day.emergency = { name: String(name).slice(0, 80), phone: String(phone).slice(0, 30), setBy: by, at: Date.now() }; });
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
  const familyTrials = (playerIds, { minorDevice = false } = {}) => trials.forPlayers(playerIds)
    .map((t) => {
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
    // Paged by cursor (domains/platform/paging.mjs): { items, nextCursor }, oldest trial first. The admin app reads the
    // first page only; a "load more" is not built yet (the decision of 4 November 2026).
    let page;
    try { page = readPage(req.query, ['number', 'number']); } catch (e) { return sendPageError(res, e); }
    const { items, nextCursor } = trials.staffChecksPage({ pendingOnly: req.query.all !== '1', ...page });
    res.json({ items: items.map((r) => ({ ...r, check: { ...r.check, state: checkState(r.check) } })), nextCursor });
  });

  adminRouter.post('/staff-checks/:trialId/:staffId', (req, res) => {
    const t = trials.byId(req.params.trialId);
    const s = t?.day?.staff.find((x) => x.id === req.params.staffId);
    if (!s?.check) return res.status(404).json({ error: 'CHECK_NOT_FOUND' });
    const { status, expiresAt } = req.body ?? {};
    if (!['reviewed', 'rejected'].includes(status)) return res.status(400).json({ error: 'STATUS_INVALID', allowed: ['reviewed', 'rejected'] });
    const exp = checkExpiryOrRefuse(res, expiresAt);
    if (exp === undefined) return;
    const fresh = trials.update(t.id, (d) => {
      const c = d.day.staff.find((x) => x.id === s.id).check;
      c.status = status;
      c.reviewedBy = 'Trust & Safety';
      c.reviewedAt = Date.now();
      if (exp !== null) c.expiresAt = exp;
    });
    const check = fresh.day.staff.find((x) => x.id === s.id).check;
    res.json({ check: { ...check, state: checkState(check) } });
  });
}

/**
 * The player's opportunity board — what they could actually apply to, with
 * eligibility computed the same way the application gate computes it.
 * Pure over the reads and the injected rules; shared by the player, guardian and
 * (M23 P5.6B) Agent client-workspace readers. S9d: the open opportunities come
 * from SQL (published, deadline today or later) and the player's own live
 * applications in one query; the open days are still db.openTrials (S13).
 */
export function opportunityBoardFor(db, player, { orgCanSee, checkEligibility, distanceBand, scoutingReads, orgOf }) {
  if (!scoutingReads?.opportunities || typeof orgOf !== 'function') throw new TypeError('opportunityBoardFor needs scoutingReads and orgOf');
  const today = new Date().toISOString().slice(0, 10);
  const mine = new Map(scoutingReads.applications.forPlayers([player.id]).filter((a) => a.status !== 'withdrawn').map((a) => [a.opportunityId, a]));
  const rows = [];
  for (const o of scoutingReads.opportunities.openOn(today)) {
    const org = orgOf(o.orgId);
    if (!org || org.suspended) continue;
    if (!orgCanSee(org, player)) continue; // visibility is mutual: an org that can't see the player can't receive their application
    const { eligible } = checkEligibility(o.eligibility, player, org);
    if (!eligible) continue;
    const existing = mine.get(o.id);
    rows.push({
      ...opportunityView(o), via: 'opportunity',
      distance: distanceBand(org.location, player.location),
      applied: existing ? { id: existing.id, status: existing.status } : null,
    });
  }
  // Existing grassroots open days ride the same board — integrated, not
  // duplicated: they keep their own registration flow and records.
  for (const t of (db.openTrials ?? []).filter((t) => t.date >= today)) {
    const org = orgOf(t.orgId);
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
