// Opportunity board and assessment campaigns. Minors are guardian-routed throughout, and eligibility fails
// closed on a missing location.

import { GRASSROOTS_RADIUS_KM } from '../../domain.mjs';
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
const PageQuery = v.strictObject(CURSOR_PAGE);

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
    users,
    unit,
    opportunitiesCampaigns,
  } = ctx;
  if (typeof opportunitiesCampaigns?.opportunities?.create !== 'function')
    throw new TypeError('registerJourneys needs the opportunities and campaigns repository from the data layer');

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
}
