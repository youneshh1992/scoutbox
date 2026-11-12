// Opportunity board, assessment campaigns and trial day. Minors are guardian-routed throughout, and eligibility fails
// closed on a missing location.

import { GRASSROOTS_RADIUS_KM, parseTrialDate, trialReportDueAt } from '../../domain.mjs';
import { parseDateOrInstant, isExpiredAt, isAbsent } from '../../temporal.mjs';
import { trialFamilyView, trialOutcomeLine } from '../recruitment/public.mjs';
import { readPage, sendPageError, pageOf, offsetPage, pageSorted } from '../platform/paging.mjs';
import {
  OPPORTUNITY_TYPES,
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITIES_CAMPAIGNS_LIMITS as OL,
  FILE_CHECK_ISSUES,
  typeEligibility,
} from '../../repositories/opportunitiesCampaigns.mjs';
import { storedName } from './passport.mjs';
import { eligibilityView, opportunityView, applicationView, opportunityBoardFor } from './views.mjs';
import * as v from 'valibot';
import {
  CURSOR_PAGE,
  ID_MAX,
  OFFSET_PAGE,
  OFFSET_PAGE_CODES,
  dayOrBlank,
  dueDate,
  filled,
  inputOrRefuse,
  oneOf,
  requiredText,
  text,
  wholeNumber,
} from '../platform/schemas.mjs';

const optText = (max) => v.nullish(text(max));
const NewOpportunity = v.strictObject({
  type: oneOf(OPPORTUNITY_TYPES),
  title: optText(OL.title),
  deadline: v.optional(dayOrBlank),
  team: optText(OL.team),
  ageGroup: optText(OL.ageGroup),
  role: optText(OL.role),
  description: optText(OL.description),
  schedule: optText(OL.schedule),
  category: v.nullish(oneOf(OPPORTUNITY_CATEGORIES)),
  capacity: v.nullish(wholeNumber({ min: 1 })),
  requirements: v.nullish(v.pipe(v.array(requiredText(OL.requirement)), v.maxLength(OL.requirements))),
  // eligibilityOrRefuse applies the grassroots rules and the eligibility typer.
  eligibility: v.optional(v.unknown()),
});
const OPPORTUNITY_CODES = { fieldCodes: { type: 'TYPE_INVALID' } };
const ApplicationNote = v.strictObject({ note: optText(OL.note) });
const ApplicationOutcome = v.strictObject({ decision: oneOf(['accepted', 'declined']), note: optText(OL.outcomeNote) });
const DECISION_CODES = { fieldCodes: { decision: 'DECISION_INVALID' } };
const Drill = v.strictObject({
  name: requiredText(OL.drillName),
  instructions: optText(OL.instructions),
  recording: v.nullish(
    v.strictObject({
      equipment: optText(OL.recording),
      distance: optText(OL.recording),
      surface: optText(OL.recording),
      camera: optText(OL.recording),
    }),
  ),
});
const NewCampaign = v.strictObject({
  title: optText(OL.title),
  deadline: v.optional(dayOrBlank),
  drills: v.nullish(v.pipe(v.array(Drill), v.maxLength(OL.drills))),
  attemptsAllowed: v.nullish(wholeNumber({ min: 1, max: OL.attemptsAllowed })),
  rubric: v.nullish(
    v.pipe(
      v.array(v.strictObject({ criterion: requiredText(OL.criterion), guidance: optText(OL.guidance) })),
      v.maxLength(OL.rubric),
    ),
  ),
  eligibility: v.optional(v.unknown()),
});
// An empty mediaId is an attempt with no clip: it fails the file checks rather than the request.
const Attempt = v.strictObject({ mediaId: optText(ID_MAX), drillName: v.nullish(v.string()), note: optText(OL.note) });
const AttemptReview = v.strictObject({
  decision: oneOf(['accepted', 'returned']),
  reasons: optText(OL.reasons),
  rubricNotes: optText(OL.rubricNotes),
});
// The trial-day lengths are the trial table's.
const TrialStaff = v.strictObject({
  name: optText(80),
  role: optText(60),
  check: v.nullish(v.strictObject({ kind: optText(60), ref: optText(60), expiresAt: v.optional(dueDate) })),
});
const Arrival = v.strictObject({
  time: optText(40),
  address: optText(200),
  notes: optText(300),
  collection: optText(300),
});
const TrialCancel = v.strictObject({ reason: optText(200) });
const TrialPostpone = v.strictObject({ reason: optText(200), newDate: v.nullish(v.string()) });
const POSTPONE_CODES = { fieldCodes: { newDate: 'TRIAL_DATE_INVALID' } };
const EmergencyContact = v.strictObject({ name: optText(80), phone: optText(30) });
const StaffCheckReview = v.strictObject({ status: oneOf(['reviewed', 'rejected']), expiresAt: v.optional(dueDate) });
const STAFF_CHECK_CODES = { fieldCodes: { status: 'STATUS_INVALID' } };
const PageQuery = v.strictObject(CURSOR_PAGE);
const StaffChecksQuery = v.strictObject({ ...CURSOR_PAGE, all: v.optional(oneOf(['0', '1'])) });

const campaignView = (c) => ({
  id: c.id,
  orgId: c.orgId,
  orgName: c.orgName,
  title: c.title,
  drills: c.drills.map((d) => ({
    name: d.name,
    instructions: d.instructions,
    recording: {
      equipment: d.recording.equipment,
      distance: d.recording.distance,
      surface: d.recording.surface,
      camera: d.recording.camera,
    },
  })),
  deadline: c.deadline,
  attemptsAllowed: c.attemptsAllowed,
  eligibility: eligibilityView(c.eligibility),
  rubric: c.rubric.map((r) => ({ criterion: r.criterion, guidance: r.guidance })),
  status: c.status,
  createdBy: c.createdBy,
  createdAt: c.createdAt,
});
const attemptView = (a) => ({
  id: a.id,
  mediaId: a.mediaId,
  drillName: a.drillName,
  note: a.note,
  fileChecks: {
    passed: a.fileChecks.passed,
    issues: [...a.fileChecks.issues],
    checkedAt: a.fileChecks.checkedAt,
    kind: a.fileChecks.kind,
  },
  status: a.status,
  review: a.review
    ? {
        byUserId: a.review.byUserId,
        byName: a.review.byName,
        at: a.review.at,
        kind: a.review.kind,
        reasons: a.review.reasons,
        rubricNotes: a.review.rubricNotes,
      }
    : null,
  submittedAt: a.submittedAt,
});
const submissionView = (s) => ({
  id: s.id,
  campaignId: s.campaignId,
  orgId: s.orgId,
  playerId: s.playerId,
  playerName: s.playerName,
  submittedBy: { kind: s.submittedBy.kind, id: s.submittedBy.id, name: s.submittedBy.name },
  attempts: s.attempts.map(attemptView),
  createdAt: s.createdAt,
});

export function registerJourneys(ctx) {
  const {
    byId,
    scoutingReads,
    nextId,
    notify,
    ledgerAppend,
    broadcast,
    findPlayer,
    orgRouter,
    playerRouter,
    guardianRouter,
    adminRouter,
    orgCanSee,
    paginate,
    audit,
    requireLead,
    isLead,
    moderateOrRefuse,
    isAdult,
    checkEligibility,
    distanceBand,
    guardianOwnsChild,
    recordActivity,
    DRILLS,
    players,
    users,
    unit,
    recruitment,
    opportunitiesCampaigns,
  } = ctx;
  if (typeof opportunitiesCampaigns?.opportunities?.create !== 'function')
    throw new TypeError('registerJourneys needs the opportunities and campaigns repository from the data layer');
  // The views hand out read-only records; a trial-day change is a named trial operation.
  const trials = recruitment?.trials;
  if (!trials) throw new TypeError('registerJourneys needs the recruitment repository from the data layer');

  // ===================================================== opportunity board
  const OPP_TYPES = OPPORTUNITY_TYPES;
  const fieldInvalid = (res, field, message) => {
    res.status(400).json({ error: 'FIELD_INVALID', field, message });
    return undefined;
  };
  const today = () => new Date().toISOString().slice(0, 10);

  /** The grassroots rules are forced (amateur and semi-pro only, the 50 km radius). Undefined after a 400. */
  function eligibilityOrRefuse(res, raw, org, { category } = {}) {
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw)))
      return fieldInvalid(res, 'eligibility', 'eligibility is an object.');
    const e = raw ?? {};
    const known = [
      'minAge',
      'maxAge',
      'positionGroup',
      'maxLevel',
      'radiusKm',
      ...(category === undefined ? [] : ['category']),
    ];
    const extra = Object.keys(e).find((k) => !known.includes(k));
    if (extra) return fieldInvalid(res, `eligibility.${extra}`, `eligibility has no field ${extra}.`);
    const grassroots = org.level === 'grassroots';
    const record = {
      minAge: e.minAge ?? null,
      maxAge: e.maxAge ?? null,
      positionGroup: e.positionGroup ?? 'any',
      ...(category === undefined
        ? {}
        : { category: ['mens', 'womens', 'boys', 'girls'].includes(category) ? category : 'mixed' }),
      maxLevel: grassroots ? 'semi_pro' : (e.maxLevel ?? null),
      radiusKm: grassroots ? GRASSROOTS_RADIUS_KM : (e.radiusKm ?? null),
    };
    const t = typeEligibility(record, 'eligibility', { withCategory: category !== undefined });
    if (!t.ok) {
      const field = /eligibility\.(\w+)/.exec(t.reason)?.[1];
      return fieldInvalid(
        res,
        field ? `eligibility.${field}` : 'eligibility',
        `eligibility: ${t.reason.replace(/^eligibility\./, '')}.`,
      );
    }
    return t.record;
  }

  orgRouter.post('/opportunities', (req, res) => {
    const b = inputOrRefuse(res, NewOpportunity, req.body ?? {}, OPPORTUNITY_CODES);
    if (!b) return;
    if (!filled(b.title)) return res.status(400).json({ error: 'TITLE_REQUIRED', field: 'title', problem: 'required' });
    if (!b.deadline)
      return res.status(400).json({ error: 'DEADLINE_REQUIRED', field: 'deadline', problem: 'required' });
    if (b.description && !moderateOrRefuse(res, b.description, { kind: 'opportunity', orgId: req.org.id })) return;
    const category = b.category ?? 'mixed';
    const eligibility = eligibilityOrRefuse(res, b.eligibility, req.org, { category });
    if (!eligibility) return;
    const opp = opportunitiesCampaigns.opportunities.create({
      id: nextId('opp'),
      orgId: req.org.id,
      orgName: storedName(req.org.name),
      orgLevel: req.org.level ?? 'pro',
      type: b.type,
      title: b.title,
      team: b.team || null,
      category,
      ageGroup: b.ageGroup || null,
      role: b.role || null,
      description: b.description || null,
      schedule: b.schedule || null,
      deadline: b.deadline,
      capacity: b.capacity ?? null,
      eligibility,
      requirements: b.requirements ?? [],
      status: 'published',
      createdBy: storedName(req.orgUser.name),
      createdAt: Date.now(),
      closedAt: null,
      structured: null,
    });
    broadcast('opportunities', {});
    res.status(201).json({ opportunity: opportunityView(opp) });
  });

  const oppOpen = (o) => o.status === 'published' && o.deadline >= today();

  // Opportunities are closed, never deleted, so the list grows without limit and pages.
  orgRouter.get('/opportunities', (req, res) => {
    const query = inputOrRefuse(res, PageQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = pageOf(
      scoutingReads.opportunities.page(req.org.id, page).rows,
      page.limit,
      (r) => r.key,
    );
    const counts = scoutingReads.opportunities.applicationCounts(items.map((r) => r.opportunity.id));
    res.json({
      items: items.map((r) => ({
        ...opportunityView(r.opportunity),
        open: oppOpen(r.opportunity),
        ...counts[r.opportunity.id],
      })),
      nextCursor,
    });
  });

  // A module-level function so the Agent workspace projects a client's board through the same rules.
  const boardFor = (player) =>
    opportunityBoardFor(ctx.grassrootsReads, player, {
      orgCanSee,
      checkEligibility,
      distanceBand,
      scoutingReads,
      orgOf: byId.org,
    });

  // Paged by (deadline, id) after the per-player visibility and eligibility filters; bounded by the open
  // opportunities and upcoming open days, not by the player base.
  const boardKey = (o) => [String(o.deadline), String(o.id)];
  const cmpBoard = (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
  const boardPage = (player, page) =>
    pageSorted(
      boardFor(player).sort((x, y) => cmpBoard(boardKey(x), boardKey(y))),
      page,
      boardKey,
      cmpBoard,
    );

  playerRouter.get('/opportunity-board', (req, res) => {
    const query = inputOrRefuse(res, PageQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['string', 'string']);
    } catch (e) {
      return sendPageError(res, e);
    }
    res.json({
      ...boardPage(req.player, page),
      minor: req.playerIsMinor,
      note: req.playerIsMinor ? 'Applications for under-18s are made by your parent/guardian.' : null,
    });
  });

  guardianRouter.get('/children/:id/opportunity-board', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const query = inputOrRefuse(res, PageQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['string', 'string']);
    } catch (e) {
      return sendPageError(res, e);
    }
    res.json(boardPage(child, page));
  });

  function applyTo(req, res, player, submitter) {
    const o = scoutingReads.opportunities.byId(req.params.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    if (!oppOpen(o)) return res.status(409).json({ error: 'OPPORTUNITY_CLOSED' });
    const org = byId.org(o.orgId);
    if (!org || !orgCanSee(org, player))
      return res.status(403).json({ error: 'NOT_ELIGIBLE', reasons: ['this club cannot work with this profile'] });
    const { eligible, reasons } = checkEligibility(o.eligibility, player, org);
    if (!eligible) return res.status(403).json({ error: 'NOT_ELIGIBLE', reasons });
    if (scoutingReads.applications.liveFor(o.id, player.id)) return res.status(409).json({ error: 'ALREADY_APPLIED' });
    if (o.capacity && scoutingReads.opportunities.applicationCounts([o.id])[o.id].applications >= o.capacity) {
      return res.status(409).json({ error: 'CAPACITY_FULL' });
    }
    const body = inputOrRefuse(res, ApplicationNote, req.body ?? {});
    if (!body) return;
    const note = body.note || null;
    if (note && !moderateOrRefuse(res, note, { kind: 'application', playerId: player.id, orgId: o.orgId })) return;
    const at = Date.now();
    const appn = unit(() => {
      const created = opportunitiesCampaigns.applications.create({
        id: nextId('apl'),
        opportunityId: o.id,
        orgId: o.orgId,
        playerId: player.id,
        playerName: storedName(player.name),
        submittedBy: { kind: submitter.kind, id: submitter.id, name: storedName(submitter.name) },
        note,
        status: 'submitted',
        outcome: null,
        createdAt: at,
        remindedAt: null,
        suitabilitySummary: null,
        history: [historyEntry(submitter.kind, submitter.id, submitter.name, 'submitted', at)],
      });
      ledgerAppend({
        type: 'opportunity_application',
        playerId: player.id,
        orgId: o.orgId,
        orgName: o.orgName,
        userId: null,
        scoutName: submitter.name,
      });
      notify(
        { kind: 'org_user', id: usersOf(o.orgId)[0]?.id ?? '' },
        'application',
        `📥 ${player.name} applied to "${o.title}".`,
        created.id,
      );
      return created;
    });
    broadcast('applications', { playerId: player.id });
    res.status(201).json({ application: applicationView(appn) });
  }
  const usersOf = (orgId) => users.forOrg(orgId, { active: true });
  const historyEntry = (byKind, byId_, byName, action, at = Date.now()) => ({
    id: nextId('aud'),
    at,
    byKind,
    byId: byId_,
    byName: storedName(byName),
    action,
    detail: null,
  });

  playerRouter.post('/opportunities/:id/apply', (req, res) => {
    if (req.playerIsMinor) {
      // Minors never apply to clubs themselves: the guardian applies.
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Your parent or guardian makes applications for you.' });
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
    const list = scoutingReads.applications.forPlayers(playerIds);
    const opps = new Map();
    for (const a of list)
      if (!opps.has(a.opportunityId)) opps.set(a.opportunityId, scoutingReads.opportunities.byId(a.opportunityId));
    return list.map((a) => {
      const o = opps.get(a.opportunityId);
      return {
        ...applicationView(a),
        opportunity: o ? { id: o.id, title: o.title, orgName: o.orgName, type: o.type, deadline: o.deadline } : {},
      };
    });
  }
  playerRouter.get('/applications', (req, res) => res.json(myApplications([req.player.id])));
  guardianRouter.get('/applications', (req, res) => res.json(myApplications(req.guardian.childIds)));

  function withdrawApplication(req, res, allowedPlayerIds, actor) {
    const a = scoutingReads.applications.ofPlayers(req.params.id, allowedPlayerIds);
    if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
    if (a.status !== 'submitted') return res.status(409).json({ error: 'NOT_WITHDRAWABLE', status: a.status });
    const withdrawn = opportunitiesCampaigns.applications.withdraw(
      a.id,
      {},
      { history: [historyEntry(actor.kind, actor.id, actor.name, 'withdrawn')] },
    );
    res.json({ application: applicationView(withdrawn) });
  }
  playerRouter.post('/applications/:id/withdraw', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED' });
    withdrawApplication(req, res, [req.player.id], { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.post('/applications/:id/withdraw', (req, res) =>
    withdrawApplication(req, res, req.guardian.childIds, {
      kind: 'guardian',
      id: req.guardian.id,
      name: req.guardian.name,
    }),
  );

  orgRouter.get('/opportunities/:id/applications', (req, res) => {
    const o = scoutingReads.opportunities.ofOrg(req.params.id, req.org.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    const query = inputOrRefuse(res, v.strictObject(OFFSET_PAGE), req.query ?? {}, {
      root: 'query',
      fieldCodes: OFFSET_PAGE_CODES,
    });
    if (!query) return;
    const { limit, offset } = offsetPage(query);
    const { total, items } = scoutingReads.applications.pageForOpportunity(o.id, { limit, offset });
    res.json({ total, limit, offset, items: items.map(applicationView) });
  });

  orgRouter.post('/applications/:id/outcome', (req, res) => {
    const a = scoutingReads.applications.ofOrg(req.params.id, req.org.id);
    if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
    if (a.outcome) return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    if (a.status === 'withdrawn') return res.status(409).json({ error: 'WITHDRAWN' });
    const body = inputOrRefuse(res, ApplicationOutcome, req.body ?? {}, DECISION_CODES);
    if (!body) return;
    const { decision } = body;
    const note = body.note || null;
    if (note && !moderateOrRefuse(res, note, { kind: 'application_outcome', playerId: a.playerId, orgId: req.org.id }))
      return;
    const at = Date.now();
    const p = findPlayer(a.playerId);
    const title = scoutingReads.opportunities.byId(a.opportunityId)?.title;
    const resolved = unit(() => {
      const fresh = opportunitiesCampaigns.applications.decide(
        a.id,
        { decision, note, byUserId: req.orgUser.id, byName: storedName(req.orgUser.name), at },
        { history: [historyEntry('org', req.orgUser.id, req.orgUser.name, decision, at)] },
      );
      const text =
        decision === 'accepted'
          ? `✅ ${req.org.name} accepted the application to "${title}". They'll follow up through ScoutBox.`
          : `${req.org.name} on your application: ${fresh.outcome.note ?? 'not this time — keep playing, keep logging.'}`;
      if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'application', text, a.id);
      else if (p) notify({ kind: 'player', id: p.id }, 'application', text, a.id);
      return fresh;
    });
    broadcast('applications', { playerId: a.playerId });
    res.json({ application: applicationView(resolved) });
  });

  // Closing an opportunity with unresolved applications is refused (no ghosting); the sweep nags outstanding ones.
  orgRouter.post('/opportunities/:id/close', (req, res) => {
    const o = scoutingReads.opportunities.ofOrg(req.params.id, req.org.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    const { outstanding } = scoutingReads.opportunities.applicationCounts([o.id])[o.id];
    if (outstanding)
      return res.status(409).json({
        error: 'OUTCOMES_OUTSTANDING',
        count: outstanding,
        message: 'Every applicant gets an answer before the door closes.',
      });
    if (o.status === 'closed') return res.json({ opportunity: opportunityView(o) }); // closing twice keeps the first close
    const closed = opportunitiesCampaigns.opportunities.close(o.id, { at: Date.now() });
    res.json({ opportunity: opportunityView(closed) });
  });

  // ============================================================= campaigns
  // The machine checks files; a human checks football. The two verdicts are kept apart.

  /** The schema has checked each drill's shape; this refuses a repeated name and fills the recording defaults. */
  function drillsOrRefuse(res, drills) {
    const out = [];
    const names = new Set();
    for (const [i, d] of drills.entries()) {
      if (names.has(d.name)) return fieldInvalid(res, `drills[${i}].name`, `two drills are called "${d.name}".`);
      names.add(d.name);
      const r = d.recording ?? {};
      out.push({
        name: d.name,
        instructions: d.instructions ?? '',
        recording: {
          equipment: r.equipment ?? 'Any phone camera',
          distance: r.distance ?? 'Full area in frame',
          surface: r.surface ?? 'Flat grass/turf',
          camera: r.camera ?? 'Fixed, side-on',
        },
      });
    }
    return out;
  }

  orgRouter.post('/campaigns', (req, res) => {
    const b = inputOrRefuse(res, NewCampaign, req.body ?? {});
    if (!b) return;
    if (!filled(b.title) || !b.drills?.length) return res.status(400).json({ error: 'TITLE_AND_DRILLS_REQUIRED' });
    if (!b.deadline)
      return res.status(400).json({ error: 'DEADLINE_REQUIRED', field: 'deadline', problem: 'required' });
    const attemptsAllowed = b.attemptsAllowed ?? 2;
    const drills = drillsOrRefuse(res, b.drills);
    if (!drills) return;
    const rubric = (b.rubric ?? []).map((r) => ({ criterion: r.criterion, guidance: r.guidance ?? '' }));
    const eligibility = eligibilityOrRefuse(res, b.eligibility, req.org);
    if (!eligibility) return;
    const camp = opportunitiesCampaigns.campaigns.create({
      id: nextId('cmp'),
      orgId: req.org.id,
      orgName: storedName(req.org.name),
      title: b.title,
      drills,
      deadline: b.deadline,
      attemptsAllowed,
      eligibility,
      rubric,
      status: 'published',
      createdBy: storedName(req.orgUser.name),
      createdAt: Date.now(),
    });
    broadcast('campaigns', {});
    res.status(201).json({ campaign: campaignView(camp) });
  });

  orgRouter.get('/campaigns', (req, res) => {
    const query = inputOrRefuse(res, PageQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = pageOf(scoutingReads.campaigns.page(req.org.id, page).rows, page.limit, (r) => r.key);
    const counts = scoutingReads.campaigns.submissionCounts(items.map((r) => r.campaign.id));
    res.json({ items: items.map((r) => ({ ...campaignView(r.campaign), ...counts[r.campaign.id] })), nextCursor });
  });

  const campOpen = (c) => c.status === 'published' && c.deadline >= today();

  function campaignsFor(player) {
    const mine = new Map(scoutingReads.campaignSubmissions.forPlayer(player.id).map((s) => [s.campaignId, s]));
    return scoutingReads.campaigns
      .openOn(today())
      .map((c) => {
        const org = byId.org(c.orgId);
        if (!org || org.suspended || !orgCanSee(org, player)) return null;
        const { eligible } = checkEligibility(c.eligibility, player, org);
        if (!eligible) return null;
        const sub = mine.get(c.id);
        return { ...campaignView(c), mySubmission: sub ? submissionView(sub) : null };
      })
      .filter(Boolean);
  }

  playerRouter.get('/campaigns', (req, res) => res.json({ items: campaignsFor(req.player) }));
  guardianRouter.get('/children/:id/campaigns', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    res.json({ items: campaignsFor(child) });
  });

  // File checks only (exists, is video, within the size cap); says nothing about how the drill was done.
  function fileChecks(player, mediaId) {
    const issues = [];
    const media = mediaId ? player.media.find((m) => m.id === mediaId) : null;
    if (!media) issues.push(FILE_CHECK_ISSUES.media_missing);
    else {
      if (media.kind !== 'video') issues.push(FILE_CHECK_ISSUES.not_video);
      if (!media.url && !media.id.startsWith('media-seed')) {
        // metadata-only entry: the bytes were never uploaded
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
    if (!org || !orgCanSee(org, player) || !eligible)
      return res.status(403).json({ error: 'NOT_ELIGIBLE', reasons: reasons ?? [] });
    const existing = scoutingReads.campaignSubmissions.forCampaignPlayer(camp.id, player.id);
    // Only attempts that reached review count against the policy: a failed file check never burns an attempt.
    const activeAttempts = (existing?.attempts ?? []).filter((a) =>
      ['submitted', 'accepted'].includes(a.status),
    ).length;
    if (activeAttempts >= camp.attemptsAllowed)
      return res.status(409).json({ error: 'ATTEMPTS_EXHAUSTED', allowed: camp.attemptsAllowed });
    const body = inputOrRefuse(res, Attempt, req.body ?? {});
    if (!body) return;
    const { mediaId, drillName, note } = body;
    if (drillName !== undefined && drillName !== null && !camp.drills.some((d) => d.name === drillName))
      return fieldInvalid(
        res,
        'drillName',
        `drillName is one of this campaign's drills: ${camp.drills.map((d) => d.name).join(', ')}.`,
      );
    if ((existing?.attempts.length ?? 0) >= OL.attempts)
      return res.status(409).json({
        error: 'ATTEMPTS_EXHAUSTED',
        allowed: camp.attemptsAllowed,
        message: 'This submission holds as many attempts as it can.',
      });
    if (note && !moderateOrRefuse(res, note, { kind: 'campaign_note', playerId: player.id, orgId: camp.orgId })) return;
    const checks = fileChecks(player, mediaId);
    const attempt = {
      id: nextId('att'),
      mediaId: mediaId || null,
      drillName: drillName ?? camp.drills[0].name,
      note: note || null,
      fileChecks: checks,
      // Passing file checks makes an attempt "submitted", never "verified": human review is a separate state.
      status: checks.passed ? 'submitted' : 'failed_checks',
      review: null,
      submittedAt: Date.now(),
    };
    const sub = unit(() => {
      const s = existing
        ? opportunitiesCampaigns.submissions.addAttempt(existing.id, { attempt })
        : opportunitiesCampaigns.submissions.create({
            id: nextId('csb'),
            campaignId: camp.id,
            orgId: camp.orgId,
            playerId: player.id,
            playerName: storedName(player.name),
            submittedBy: { kind: submitter.kind, id: submitter.id, name: storedName(submitter.name) },
            attempts: [attempt],
            createdAt: Date.now(),
          });
      if (checks.passed)
        notify(
          { kind: 'org_user', id: usersOf(camp.orgId)[0]?.id ?? '' },
          'campaign',
          `🎬 ${player.name} submitted an attempt to "${camp.title}" — human review needed.`,
          s.id,
        );
      return s;
    });
    const stored = sub.attempts.find((a) => a.id === attempt.id);
    res.status(201).json({
      attempt: attemptView(stored),
      submission: submissionView(sub),
      note: checks.passed
        ? 'File checks passed. A coach still has to review the drill itself — that is a separate, human step.'
        : 'Automated file checks failed — fix the issues and resubmit.',
    });
  }

  playerRouter.post('/campaigns/:id/submit', (req, res) => {
    // Campaign attempts are football activity (like drills), so an eligible minor may upload; club-facing review
    // conversation stays with the guardian.
    submitAttempt(req, res, req.player, { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.post('/children/:childId/campaigns/:id/submit', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.childId)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.childId);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    submitAttempt(req, res, child, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  orgRouter.get('/campaigns/:id/review-queue', (req, res) => {
    const camp = scoutingReads.campaigns.ofOrg(req.params.id, req.org.id);
    if (!camp) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
    const queue = scoutingReads.campaignSubmissions.forCampaign(camp.id).flatMap((s) =>
      s.attempts
        .filter((a) => a.status === 'submitted')
        .map((a) => ({
          submissionId: s.id,
          playerId: s.playerId,
          playerName: s.playerName,
          attempt: { ...attemptView(a), mediaUrl: a.mediaId ? `/media/${a.mediaId}` : null },
        })),
    );
    res.json({ campaign: { id: camp.id, title: camp.title, rubric: camp.rubric }, queue });
  });

  orgRouter.post('/campaign-attempts/:id/review', (req, res) => {
    const found = scoutingReads.campaignSubmissions.byAttempt(req.params.id);
    const sub = found && found.orgId === req.org.id ? found : null;
    const attempt = sub?.attempts.find((a) => a.id === req.params.id);
    if (!attempt) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    if (attempt.status !== 'submitted')
      return res.status(409).json({ error: 'NOT_REVIEWABLE', status: attempt.status });
    const body = inputOrRefuse(res, AttemptReview, req.body ?? {}, DECISION_CODES);
    if (!body) return;
    const { decision, reasons, rubricNotes } = body;
    if (decision === 'returned' && !filled(reasons)) {
      return res.status(400).json({
        error: 'REASONS_REQUIRED',
        message: 'A returned attempt tells the player exactly what to fix and how to resubmit.',
      });
    }
    if (
      reasons &&
      !moderateOrRefuse(res, reasons, { kind: 'campaign_review', playerId: sub.playerId, orgId: req.org.id })
    )
      return;
    const p = findPlayer(sub.playerId);
    const camp = scoutingReads.campaigns.byId(sub.campaignId);
    const reviewed = unit(() => {
      const fresh = opportunitiesCampaigns.submissions
        .reviewAttempt(sub.id, {
          attemptId: attempt.id,
          decision,
          review: {
            byUserId: req.orgUser.id,
            byName: storedName(req.orgUser.name),
            at: Date.now(),
            kind: 'human_review',
            reasons: reasons || null,
            rubricNotes: rubricNotes || null,
          },
        })
        .attempts.find((x) => x.id === attempt.id);
      const text =
        decision === 'accepted'
          ? `✅ Your "${camp?.title}" attempt was reviewed and accepted by ${req.org.name}.`
          : `↩️ ${req.org.name} returned your "${camp?.title}" attempt: ${fresh.review.reasons} — you can resubmit.`;
      if (p && !isAdult(p) && p.guardianId)
        notify({ kind: 'guardian', id: p.guardianId }, 'campaign', `${p.name}: ${text}`, sub.id);
      if (p) notify({ kind: 'player', id: p.id }, 'campaign', text, sub.id);
      if (p && decision === 'accepted') recordActivity(p);
      return fresh;
    });
    res.json({ attempt: attemptView(reviewed) });
  });

  // ============================================================= trial day
  // A reference on file is not a completed check; check-in feeds the existing attendance without duplicates.

  function trialFor(req, res) {
    const found = trials.byId(req.params.id);
    const t = found && found.orgId === req.org.id ? found : null;
    if (!t) {
      res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
      return null;
    }
    // A trial whose subject removed their account can still be read (the record is the club's), but nothing new is
    // written about a person who left.
    if (t.subjectRemovedAt && req.method !== 'GET') {
      res.status(409).json({
        error: 'TRIAL_SUBJECT_REMOVED',
        message: 'This player removed their ScoutBox account. The trial stays on record; it can no longer be changed.',
      });
      return null;
    }
    return t;
  }

  orgRouter.get('/trials/:id/day', (req, res) => {
    const t = trialFor(req, res);
    if (t) res.json({ trial: trialDayView(t, 'org') });
  });

  /**
   * A reviewed check whose expiry cannot be read reads `expired` (`NaN < now` is false, so it would otherwise stay
   * reviewed for ever). A missing expiry stays "no expiry recorded".
   */
  function checkState(c, now = Date.now()) {
    if (!c) return 'missing';
    if (c.status === 'reviewed' && !isAbsent(c.expiresAt) && isExpiredAt(readCheckExpiry(c.expiresAt), now))
      return 'expired';
    return c.status;
  }
  /** A stored check expiry (a DATE_ONLY valid through that day, or an instant) as the first instant it no longer holds; NaN when unreadable. */
  function readCheckExpiry(v) {
    const p = parseDateOrInstant(v, { dayEdge: 'end' });
    return p.ok ? p.ms : NaN;
  }
  function checkExpiryOrRefuse(res, raw) {
    if (isAbsent(raw)) return null;
    const p = parseDateOrInstant(raw, { dayEdge: 'end' });
    if (!p.ok) {
      res.status(400).json({
        error: 'DATE_INVALID',
        field: 'expiresAt',
        message: `A check expiry is a calendar day (YYYY-MM-DD) or an ISO 8601 date-time with an offset (${p.why}).`,
        expected: p.expected,
      });
      return undefined;
    }
    return p.precision === 'day' ? p.value : new Date(p.ms).toISOString();
  }

  function trialDayView(t, side) {
    const day = t.day ?? {};
    const base = {
      id: t.id,
      playerId: t.playerId,
      playerName: t.playerName,
      orgId: t.orgId,
      orgName: t.orgName,
      proposedDate: t.proposedDate,
      venue: t.venue,
      reportDueAt: t.reportDueAt,
      staff: (day.staff ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        check: { kind: s.check?.kind ?? null, status: checkState(s.check), expiresAt: s.check?.expiresAt ?? null },
      })),
      arrival: day.arrival,
      collection: day.collection,
      consents: (day.consents ?? []).map((c) => ({ id: c.id, byKind: c.by.kind, scope: c.scope, at: c.at })),
      checkins: day.checkins ?? [],
      statusEvents: day.statusEvents ?? [],
      cancelled: (day.statusEvents ?? []).some((e) => e.kind === 'cancelled'),
    };
    if (side === 'org') {
      // The emergency contact is for the day's named safety staff only: it appears here and nowhere else. A block by
      // the player or guardian withholds it, evaluated on every read, so it returns if Trust & Safety lifts the block.
      // What a blocked club may still do with a trial is a policy decision, not a read-side one.
      const blocked = ctx.isBlocked(t.playerId, t.orgId);
      base.emergency = blocked ? null : (day.emergency ?? null);
      base.emergencyWithheld = blocked ? 'BLOCKED' : null;
    }
    return base;
  }

  orgRouter.post('/trials/:id/staff', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    const body = inputOrRefuse(res, TrialStaff, req.body ?? {});
    if (!body) return;
    const { check } = body;
    const name = filled(body.name);
    const role = filled(body.role);
    if (!name || !role) return res.status(400).json({ error: 'NAME_AND_ROLE_REQUIRED' });
    const expiresAt = check ? checkExpiryOrRefuse(res, check.expiresAt) : null;
    if (expiresAt === undefined) return;
    const s = {
      id: nextId('stf'),
      name,
      role,
      check: check
        ? {
            kind: filled(check.kind) ?? 'DBS (England & Wales)',
            ref: filled(check.ref),
            // Filing a reference does not make it reviewed: Trust & Safety moves it to 'reviewed'.
            status: 'pending',
            expiresAt,
            reviewedBy: null,
          }
        : null,
      addedBy: req.orgUser.name,
      addedAt: Date.now(),
    };
    trials.addStaff(t.id, { staff: s });
    res.status(201).json({
      staff: s,
      note: 'The check is PENDING until Trust & Safety reviews it — an uploaded reference is not a completed background check.',
    });
  });

  orgRouter.post('/trials/:id/arrival', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    const body = inputOrRefuse(res, Arrival, req.body ?? {});
    if (!body) return;
    const { time, address, notes, collection } = body;
    if (notes && !moderateOrRefuse(res, notes, { kind: 'trial_arrival', playerId: t.playerId, orgId: req.org.id }))
      return;
    const fresh = unit(() => {
      const set = trials.setArrival(t.id, {
        arrival: {
          time: time || null,
          address: address || null,
          notes: notes || null,
        },
        collection: collection ? { policy: collection } : null,
      });
      notifyTrialParties(
        set,
        `📍 ${set.orgName} published arrival details for the trial on ${set.proposedDate ?? 'TBC'}.`,
      );
      return set;
    });
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
    const body = inputOrRefuse(
      res,
      kind === 'postponed' ? TrialPostpone : TrialCancel,
      req.body ?? {},
      kind === 'postponed' ? POSTPONE_CODES : {},
    );
    if (!body) return;
    const { newDate } = body;
    const reason = filled(body.reason);
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED', field: 'reason', problem: 'required' });
    // The report deadline is re-derived from the new day by the shared derivation, never computed here.
    const moved = kind === 'postponed' ? parseTrialDate(newDate) : { ok: true, value: null };
    if (!moved.ok) return res.status(400).json({ ...moved, field: 'newDate' });
    const event = {
      kind,
      at: Date.now(),
      by: req.orgUser.name,
      reason,
      newDate: moved.value,
    };
    const fresh = unit(() => {
      const recorded = trials.recordDayStatus(
        t.id,
        kind === 'postponed' && moved.value
          ? { event, proposedDate: moved.value, reportDueAt: trialReportDueAt(moved.value, t.acceptedAt) }
          : { event },
      );
      notifyTrialParties(
        recorded,
        kind === 'cancelled'
          ? `❌ ${recorded.orgName} cancelled the trial: ${reason}`
          : `📅 ${recorded.orgName} moved the trial to ${newDate ?? 'a new date TBC'}: ${reason}`,
      );
      return recorded;
    });
    res.json({ trial: trialDayView(fresh, 'org') });
  }
  orgRouter.post('/trials/:id/cancel', (req, res) => cancelOrPostpone(req, res, 'cancelled'));
  orgRouter.post('/trials/:id/postpone', (req, res) => cancelOrPostpone(req, res, 'postponed'));

  // Check-in needs a reviewed, unexpired check on at least one named staff member and the right consent.
  orgRouter.post('/trials/:id/checkin', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    if (t.day.statusEvents.some((e) => e.kind === 'cancelled'))
      return res.status(409).json({ error: 'TRIAL_CANCELLED' });
    const okStaff = t.day.staff.some((s) => checkState(s.check) === 'reviewed');
    if (!okStaff)
      return res.status(409).json({
        error: 'STAFF_CHECK_REQUIRED',
        message:
          'At least one named staff member needs a REVIEWED, unexpired background check before anyone checks in.',
      });
    const p = findPlayer(t.playerId);
    const minor = p && !isAdult(p);
    const requiredScope = minor ? 'guardian_event_consent' : 'player_event_consent';
    if (!t.day.consents.some((c) => c.scope === requiredScope)) {
      return res.status(409).json({
        error: 'CONSENT_REQUIRED',
        scope: requiredScope,
        message: minor
          ? 'The guardian has not given event consent for this trial day.'
          : 'The player has not given event consent for this trial day.',
      });
    }
    if (t.day.checkins.some((c) => c.playerId === t.playerId))
      return res.status(409).json({ error: 'ALREADY_CHECKED_IN' });
    const checkedInAt = Date.now();
    const fresh = unit(() => {
      // The session whose window holds this moment (from two hours before its start) gets one append-only `attended`
      // record with source `checkin`. A trial without a schedule records nothing new here.
      const by = { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name };
      const sessions = t.schedule?.confirmedAt ? t.schedule.sessions : [];
      const live = sessions.find((s) => s.startsAt - 2 * 3600_000 <= checkedInAt && checkedInAt <= s.endsAt) ?? null;
      const attends = live && !t.attendance.some((a) => a.sessionId === live.id && a.state === 'attended');
      const checkedIn = trials.checkIn(
        t.id,
        {
          checkin: { playerId: t.playerId, at: checkedInAt, byUserId: req.orgUser.id, byName: req.orgUser.name },
          attendance: attends
            ? {
                sessionId: live.id,
                state: 'attended',
                source: 'checkin',
                recordedBy: by,
                recordedAt: checkedInAt,
                note: null,
              }
            : null,
        },
        attends
          ? {
              at: checkedInAt,
              bump: true,
              revBy: req.orgUser,
              history: [
                {
                  id: nextId('aud'),
                  at: checkedInAt,
                  action: 'trial_attendance_recorded',
                  by,
                  detail: { sessionId: live.id, state: 'attended', source: 'checkin' },
                },
              ],
            }
          : {},
      );
      // Feed the existing attendance record once.
      if (p && !(p.attendance ?? []).some((a) => a.trialId === t.id)) {
        players.addItem(p.id, 'attendance', {
          id: nextId('att'),
          trialId: t.id,
          fixture: `Trial day · ${t.orgName}`,
          venue: t.venue ?? '',
          date: t.proposedDate ?? new Date().toISOString().slice(0, 10),
          gps: null,
          verified: true,
          corroboratedBy: t.orgName,
        });
        recordActivity(p);
      }
      ledgerAppend({
        type: 'trial_checkin',
        playerId: t.playerId,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
      return checkedIn;
    });
    res.json({ trial: trialDayView(fresh, 'org') });
  });

  function playerTrial(req, res, playerIds) {
    const found = trials.byId(req.params.id);
    const t = found && playerIds.includes(found.playerId) ? found : null;
    if (!t) {
      res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
      return null;
    }
    return t;
  }

  function giveConsent(req, res, t, by, scope) {
    if (t.day.consents.some((c) => c.scope === scope && c.by.id === by.id))
      return res.status(409).json({ error: 'ALREADY_CONSENTED' });
    trials.giveConsent(t.id, { consent: { id: nextId('cns'), by, scope, at: Date.now() } });
    res.status(201).json({ consented: scope });
  }

  playerRouter.post('/trials/:id/consent', (req, res) => {
    if (req.playerIsMinor)
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Event consent for under-18s comes from the guardian.' });
    const t = playerTrial(req, res, [req.player.id]);
    if (t)
      giveConsent(req, res, t, { kind: 'player', id: req.player.id, name: req.player.name }, 'player_event_consent');
  });

  guardianRouter.post('/trials/:id/consent', (req, res) => {
    const t = playerTrial(req, res, req.guardian.childIds);
    if (t)
      giveConsent(
        req,
        res,
        t,
        { kind: 'guardian', id: req.guardian.id, name: req.guardian.name },
        'guardian_event_consent',
      );
  });

  function setEmergency(req, res, t, by) {
    const body = inputOrRefuse(res, EmergencyContact, req.body ?? {});
    if (!body) return;
    const name = filled(body.name);
    const phone = filled(body.phone);
    if (!name || !phone) return res.status(400).json({ error: 'NAME_AND_PHONE_REQUIRED' });
    // Readable only in the org's trial-day view for this event; never in profiles, search or exports.
    trials.setEmergencyContact(t.id, {
      emergency: { name, phone, setBy: by, at: Date.now() },
    });
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
        checksExplained:
          'A "reviewed" check means Trust & Safety examined the club’s filed reference for that person. "Pending" means it has NOT been examined yet. We show you the truth rather than a badge.',
        arrival: t.day.arrival,
        collection: forGuardian ? t.day.collection : null,
        emergencySet: !!t.day.emergency,
        reportRoute:
          'Anything concerning: use ⚑ Report in the app — urgent reports suspend club communication immediately.',
        feedbackDue: Number.isFinite(t.reportDueAt) ? new Date(t.reportDueAt).toISOString().slice(0, 10) : null,
      },
    };
  }

  const familyTrials = (playerIds, { minorDevice = false } = {}) =>
    trials.forPlayers(playerIds).map((t) => {
      // A minor's own device gets the outcome line only, never the sessions, address, instructions or history the
      // guardian holds.
      return { ...trialDayView(t, 'family'), workflow: minorDevice ? trialOutcomeLine(t) : trialFamilyView(t) };
    });
  playerRouter.get('/trials', (req, res) =>
    res.json(familyTrials([req.player.id], { minorDevice: !!req.playerIsMinor })),
  );
  guardianRouter.get('/trials', (req, res) => res.json(familyTrials(req.guardian.childIds)));

  playerRouter.get('/trials/:id/safety-pack', (req, res) => {
    const t = playerTrial(req, res, [req.player.id]);
    if (t) res.json(safetyPack(t, false));
  });
  guardianRouter.get('/trials/:id/safety-pack', (req, res) => {
    const t = playerTrial(req, res, req.guardian.childIds);
    if (t) res.json(safetyPack(t, true));
  });

  // Jurisdiction-appropriate wording; nothing is auto-approved.
  adminRouter.get('/staff-checks', (req, res) => {
    // Oldest trial first. The admin app reads only the first page; "load more" awaits a product decision.
    const query = inputOrRefuse(res, StaffChecksQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number', 'number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = trials.staffChecksPage({ pendingOnly: query.all !== '1', ...page });
    res.json({ items: items.map((r) => ({ ...r, check: { ...r.check, state: checkState(r.check) } })), nextCursor });
  });

  adminRouter.post('/staff-checks/:trialId/:staffId', (req, res) => {
    const t = trials.byId(req.params.trialId);
    const s = t?.day?.staff.find((x) => x.id === req.params.staffId);
    if (!s?.check) return res.status(404).json({ error: 'CHECK_NOT_FOUND' });
    const body = inputOrRefuse(res, StaffCheckReview, req.body ?? {}, STAFF_CHECK_CODES);
    if (!body) return;
    const { status, expiresAt } = body;
    const exp = checkExpiryOrRefuse(res, expiresAt);
    if (exp === undefined) return;
    const fresh = trials.reviewStaffCheck(t.id, {
      staffId: s.id,
      status,
      reviewedBy: 'Trust & Safety',
      reviewedAt: Date.now(),
      expiresAt: exp,
    });
    const check = fresh.day.staff.find((x) => x.id === s.id).check;
    res.json({ check: { ...check, state: checkState(check) } });
  });
}
