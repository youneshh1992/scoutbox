// Travel times are never invented; candidate suggestions contain only players the org can see.
import { parseStrictDateOnly } from '../../temporal.mjs';
import { validAmountMinor, CURRENCIES } from '../recruitment/money.mjs';
import { readPage, pageOf, sendPageError } from '../platform/paging.mjs';
import { INSIGHT_LIMITS as L } from '../../repositories/insightCoverage.mjs';

export const PLAN_DEFAULTS = Object.freeze({ label: 'Coverage plan', goalObservations: 5, windowDays: 60 });
const TRAVEL_NOTE =
  'Travel time/route estimates unavailable — no routing provider is configured. The budget figure is user-entered, not a confirmed cost.';
/** A fixture's public id: an own fixture's id, or `fr-` / `tr-` and the friendly's or open day's id. */
const PREFIX = Object.freeze({ friendly_board: 'fr-', open_trial: 'tr-' });
export const publicFixtureId = ({ kind, id }) => (kind === 'own' ? id : `${PREFIX[kind]}${id}`);

const fieldInvalid = (res, field, message) => {
  res.status(400).json({ error: 'FIELD_INVALID', field, message });
  return undefined;
};
const absent = (v) => v === undefined || v === null;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= L.id;
/** absent → null; not text → undefined (refused); over-long text is shortened. */
const optText = (v, max) => (absent(v) ? null : typeof v !== 'string' ? undefined : v.trim().slice(0, max) || null);

export function registerCoverage(ctx) {
  const {
    byId,
    orgRouter,
    nextId,
    notify,
    findPlayer,
    orgCanSee,
    isLead,
    requireLead,
    haversineKm,
    insightCoverage,
    unit,
  } = ctx;
  if (!insightCoverage || typeof unit !== 'function')
    throw new TypeError('registerCoverage needs the insight and coverage repository and the unit of work');
  const { fixtures, plans, assignments } = insightCoverage;

  const fixtureView = (f) => ({
    id: f.id,
    orgId: f.orgId,
    source: 'own',
    competition: f.competition,
    home: f.home,
    away: f.away,
    date: f.date,
    location: f.location ? { ...f.location } : null,
    createdBy: f.createdBy,
    createdAt: f.createdAt,
  });
  const planView = (p) => ({
    id: p.id,
    orgId: p.orgId,
    label: p.label,
    competition: p.competition,
    region: p.region,
    goalObservations: p.goalObservations,
    windowDays: p.windowDays,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
  });
  const warningText = (w, a) =>
    w.code === 'duplicate_visit'
      ? `Duplicate visit: ${w.scoutName ?? 'a scout'} is already assigned to this fixture.`
      : `Conflict: ${w.scoutName ?? 'the scout'} already has an assignment on ${a.fixtureDate}.`;
  const assignmentView = (a) => ({
    id: a.id,
    orgId: a.orgId,
    fixtureId: publicFixtureId(a.fixture),
    fixtureDate: a.fixtureDate,
    fixtureLabel: a.fixtureLabel,
    fixtureCompetition: a.fixtureCompetition,
    scoutUserId: a.scoutUserId,
    scoutName: a.scoutName,
    targetPlayerIds: [...a.targetPlayerIds],
    travelBudget: a.travelBudget ? { ...a.travelBudget } : null,
    travelNote: TRAVEL_NOTE,
    warnings: a.warnings.map((w) => warningText(w, a)),
    assignedBy: a.assignedBy,
    createdAt: a.createdAt,
    observedAt: a.observedAt,
    assessmentIds: a.assessmentId ? [a.assessmentId] : [],
    cancelledAt: a.cancelledAt,
  });

  // ============================================================ coverage
  orgRouter.post('/coverage/fixtures', (req, res) => {
    const b = req.body ?? {};
    if (typeof b.home !== 'string' || !b.home.trim() || typeof b.away !== 'string' || !b.away.trim() || absent(b.date))
      return res.status(400).json({ error: 'FIXTURE_FIELDS', message: 'home, away and date are required.' });
    const day = parseStrictDateOnly(b.date);
    if (!day.ok || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date)))
      return res.status(400).json({
        error: 'DATE_INVALID',
        field: 'date',
        message: 'date must be a calendar day written YYYY-MM-DD.',
        expected: 'YYYY-MM-DD',
      });
    const competition = optText(b.competition, L.competition);
    if (competition === undefined) return fieldInvalid(res, 'competition', 'competition must be text.');
    let location = null;
    if (!absent(b.lat) || !absent(b.lng)) {
      const okLat = typeof b.lat === 'number' && Number.isFinite(b.lat) && Math.abs(b.lat) <= 90;
      const okLng = typeof b.lng === 'number' && Number.isFinite(b.lng) && Math.abs(b.lng) <= 180;
      if (!okLat || !okLng)
        return fieldInvalid(
          res,
          okLat ? 'lng' : 'lat',
          'A location needs both lat (−90 to 90) and lng (−180 to 180) as numbers.',
        );
      if (!absent(b.city) && typeof b.city !== 'string') return fieldInvalid(res, 'city', 'city must be text.');
      location = { lat: b.lat, lng: b.lng, city: (b.city ?? '').trim().slice(0, L.city) };
    } else if (!absent(b.city)) return fieldInvalid(res, 'city', 'city is recorded with a location (lat and lng).');
    const f = fixtures.create({
      id: nextId('fix'),
      orgId: req.org.id,
      competition,
      home: b.home.trim().slice(0, L.team),
      away: b.away.trim().slice(0, L.team),
      date: String(b.date),
      location,
      createdBy: req.orgUser.name ?? null,
      createdAt: Date.now(),
    });
    res.status(201).json({ fixture: fixtureView(f) });
  });

  // A read-time union of own fixtures and platform events the org can already see (board friendlies, open days):
  // nothing scraped, nothing copied into new rows.
  const observableView = (o) =>
    o.fixture
      ? { ...fixtureView(o.fixture), ref: o.ref }
      : {
          id: o.publicId,
          source: o.ref.kind,
          competition: o.competition,
          home: o.home,
          away: o.away,
          date: o.date,
          location: o.location ? { ...o.location } : null,
          ref: o.ref,
        };
  const withoutRef = ({ ref, ...f }) => f;

  /** `cursor` is `[date, id]`. */
  orgRouter.get('/coverage/fixtures', (req, res) => {
    let page;
    try {
      page = readPage(req.query, ['string', 'string']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, more } = insightCoverage.observable.page(req.org.id, page);
    const views = items.map(observableView).map(withoutRef);
    res.json(pageOf(more ? [...views, null] : views, page.limit, (f) => [f.date, f.id]));
  });

  orgRouter.post('/coverage-plans', (req, res) => {
    if (!requireLead(req, res)) return;
    const b = req.body ?? {};
    const label = absent(b.label) ? PLAN_DEFAULTS.label : optText(b.label, L.label);
    if (label === undefined) return fieldInvalid(res, 'label', 'label must be text.');
    const competition = optText(b.competition, L.competition);
    if (competition === undefined) return fieldInvalid(res, 'competition', 'competition must be text.');
    const region = optText(b.region, L.region);
    if (region === undefined) return fieldInvalid(res, 'region', 'region must be text.');
    const goal = absent(b.goalObservations) ? PLAN_DEFAULTS.goalObservations : b.goalObservations;
    if (!Number.isInteger(goal) || goal < L.goal[0] || goal > L.goal[1])
      return fieldInvalid(
        res,
        'goalObservations',
        `goalObservations must be a whole number from ${L.goal[0]} to ${L.goal[1]}.`,
      );
    const windowDays = absent(b.windowDays) ? PLAN_DEFAULTS.windowDays : b.windowDays;
    if (!Number.isInteger(windowDays) || windowDays < L.windowDays[0] || windowDays > L.windowDays[1])
      return fieldInvalid(
        res,
        'windowDays',
        `windowDays must be a whole number from ${L.windowDays[0]} to ${L.windowDays[1]}.`,
      );
    const p = plans.create({
      id: nextId('cvp'),
      orgId: req.org.id,
      label: label ?? PLAN_DEFAULTS.label,
      competition,
      region,
      goalObservations: goal,
      windowDays,
      createdBy: req.orgUser.name ?? null,
      createdAt: Date.now(),
    });
    res.status(201).json({ plan: planView(p) });
  });

  function planProgress(plan) {
    const done = plans.observationsFor(plan, Date.now() - plan.windowDays * 86_400_000);
    return { done, goal: plan.goalObservations, complete: done >= plan.goalObservations };
  }

  // Not paged: a club keeps a handful of plans.
  orgRouter.get('/coverage-plans', (req, res) => {
    res.json({ items: plans.forOrg(req.org.id).map((p) => ({ ...planView(p), progress: planProgress(p) })) });
  });

  orgRouter.post('/coverage/assignments', (req, res) => {
    if (!requireLead(req, res)) return;
    const b = req.body ?? {};
    const found =
      typeof b.fixtureId === 'string' ? insightCoverage.observable.byPublicId(req.org.id, b.fixtureId) : null;
    const fixture = found ? observableView(found) : null;
    if (!fixture) return res.status(404).json({ error: 'FIXTURE_NOT_FOUND' });
    const scout = byId.user(b.scoutUserId, (u) => u.orgId === req.org.id && !u.removedAt);
    if (!scout) return res.status(404).json({ error: 'SCOUT_NOT_FOUND' });
    const rawTargets = absent(b.targetPlayerIds) ? [] : b.targetPlayerIds;
    if (!Array.isArray(rawTargets) || rawTargets.length > L.targets || !rawTargets.every(isId))
      return fieldInvalid(res, 'targetPlayerIds', `targetPlayerIds must be a list of at most ${L.targets} player ids.`);
    if (new Set(rawTargets).size !== rawTargets.length)
      return fieldInvalid(res, 'targetPlayerIds', 'targetPlayerIds names a player twice.');
    let travelBudget = null;
    if (!absent(b.travelBudgetMinor)) {
      if (!validAmountMinor(b.travelBudgetMinor) || b.travelBudgetMinor < 0)
        return res.status(400).json({
          error: 'AMOUNT_INVALID',
          field: 'travelBudgetMinor',
          message: 'travelBudgetMinor must be a non-negative whole number of minor units (pence/cents).',
        });
      const currency = absent(b.travelCurrency) ? 'GBP' : b.travelCurrency;
      if (!CURRENCIES.includes(currency))
        return fieldInvalid(res, 'travelCurrency', `travelCurrency must be one of ${CURRENCIES.join(', ')}.`);
      travelBudget = { amountMinor: b.travelBudgetMinor, currency, enteredBy: req.orgUser.name ?? null };
    } else if (!absent(b.travelCurrency))
      return fieldInvalid(res, 'travelCurrency', 'travelCurrency goes with travelBudgetMinor.');
    // Invisible players are dropped, never refused, so the answer never says who is hidden.
    const targets = rawTargets
      .map(findPlayer)
      .filter((p) => p && orgCanSee(req.org, p))
      .map((p) => p.id);
    const warnings = [];
    const dup = assignments.liveForFixture(req.org.id, fixture.ref);
    if (dup) warnings.push({ code: 'duplicate_visit', scoutName: byId.user(dup.scoutUserId)?.name ?? null });
    if (assignments.scoutBusyOn(req.org.id, scout.id, fixture.date))
      warnings.push({ code: 'scout_clash', scoutName: scout.name ?? null });
    const a = unit(() => {
      const created = assignments.create({
        id: nextId('cva'),
        orgId: req.org.id,
        fixture: fixture.ref,
        fixtureDate: fixture.date,
        fixtureLabel: `${fixture.home} v ${fixture.away}`.slice(0, L.fixtureLabel),
        fixtureCompetition: fixture.competition ? String(fixture.competition).slice(0, L.competition) : null,
        scoutUserId: scout.id,
        scoutName: scout.name ?? null,
        targetPlayerIds: targets,
        travelBudget,
        warnings,
        assignedBy: req.orgUser.name ?? null,
        createdAt: Date.now(),
        observedAt: null,
        assessmentId: null,
        cancelledAt: null,
      });
      notify(
        { kind: 'org_user', id: scout.id },
        'coverage',
        `🧭 New observation assignment: ${created.fixtureLabel} on ${created.fixtureDate}${targets.length ? ` (${targets.length} target${targets.length > 1 ? 's' : ''})` : ''}.`,
        created.id,
      );
      return created;
    });
    const view = assignmentView(a);
    res.status(201).json({ assignment: view, warnings: view.warnings });
  });

  /** A scout sees only their own assignments, unless a lead. */
  orgRouter.get('/coverage/assignments', (req, res) => {
    let page;
    try {
      page = readPage(req.query, ['number', 'string']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const rows = assignments.page(req.org.id, {
      scoutUserId: isLead(req.orgUser) ? null : req.orgUser.id,
      after: page.after,
      limit: page.limit,
    });
    res.json(pageOf(rows.map(assignmentView), page.limit, (a) => [a.createdAt, a.id]));
  });

  orgRouter.post('/coverage/assignments/:id/complete', (req, res) => {
    const a = assignments.forOrgById(req.org.id, req.params.id);
    if (!a) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id && !isLead(req.orgUser))
      return res.status(403).json({ error: 'NOT_YOUR_ASSIGNMENT' });
    if (a.observedAt) return res.status(409).json({ error: 'ALREADY_COMPLETED' });
    const assessmentId = req.body?.assessmentId ?? null;
    if (
      assessmentId !== null &&
      (!isId(assessmentId) || ctx.scoutingReads.assessments.byId(assessmentId)?.orgId !== req.org.id)
    ) {
      return fieldInvalid(res, 'assessmentId', 'assessmentId must name one of your organisation’s assessments.');
    }
    res.json({ assignment: assignmentView(assignments.complete(a.id, { at: Date.now(), assessmentId })) });
  });

  orgRouter.post('/coverage/assignments/:id/cancel', (req, res) => {
    if (!requireLead(req, res)) return;
    const a = assignments.forOrgById(req.org.id, req.params.id);
    if (!a) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    res.json({ assignment: assignmentView(assignments.cancel(a.id, Date.now())) });
  });

  // Upcoming fixtures near two or more of the org's active-interest players (open cases and shortlist), by declared
  // locations within 30 km. A labelled heuristic; no schedules are scraped.
  orgRouter.get('/coverage/suggestions', (req, res) => {
    const interest = new Set([
      ...ctx.recruitmentReads.cases
        .forOrg(req.org.id)
        .filter((c) => !['closed'].includes(c.stage))
        .map((c) => c.playerId),
      ...ctx.safetyReads.ledger.playersListedBy(req.org.id),
    ]);
    const candidates = [...interest].map(findPlayer).filter((p) => p && orgCanSee(req.org, p) && p.location);
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = insightCoverage.observable.upcomingLocated(req.org.id, today).map(observableView);
    const covered = assignments.coveredKeys(req.org.id);
    const items = upcoming
      .map((f) => {
        const near = candidates.filter((p) => haversineKm(f.location, p.location) <= 30);
        return near.length >= 2
          ? {
              fixture: withoutRef(f),
              alreadyCovered: covered.has(`${f.ref.kind}:${f.ref.id}`),
              nearbyTargets: near.map((p) => ({ id: p.id, name: p.name, position: p.position })),
              rationale: `${near.length} players you track are within 30 km of this fixture's location`,
            }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.nearbyTargets.length - a.nearbyTargets.length)
      .slice(0, 10);
    res.json({
      items,
      note: 'Location-proximity heuristic over your own tracked players and visible fixtures. It does not know who will actually play, and it never includes players outside your visibility rules.',
    });
  });
}
