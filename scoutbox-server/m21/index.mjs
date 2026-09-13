/**
 * M21 — Development Hub: stores, routes and wiring.
 *
 * The Hub is WORKFLOW. It records what was agreed, who is doing it, what
 * evidence was cited and what a reviewer saw. It holds no fact about a player
 * that another store already holds: every piece of evidence is a reference
 * resolved live, the Passport stays canonical, and nothing here writes into
 * Trust, Matching or the Director Dashboard.
 *
 * Two structural decisions are worth stating up front, because they are not
 * obvious from the route list.
 *
 * **Live events are organisation-private, always.** Every event M21 broadcasts
 * carries an `orgId` and reaches that organisation's own streams and nobody
 * else's. Player-facing changes travel by notification instead, which is
 * directed at exactly one person and passes through their preferences on the
 * way. The alternative — an event carrying only a playerId — is delivered by
 * the existing rules to every organisation that can currently see the player,
 * which for a private development plan would be a leak dressed as a cache
 * ping. §44 asks that org-private development events stay org-private; making
 * every event org-private is the version of that promise with no edge cases.
 *
 * **Idempotency is natural, not a key store.** A retried create is recognised
 * by being the same create — same actor, same content, inside a short window —
 * and returns the record that already exists, the way M17 handles a repeated
 * decision. No new store, nothing to expire, and it survives a restart in the
 * only way that matters: the duplicate it would have prevented is the one the
 * client is retrying right now.
 */
import {
  DEVELOPMENT_POLICY_VERSION, DEVELOPMENT_PRINCIPLE, ACHIEVED_MEANING,
  PLAN_OWNER_KINDS, PLAN_VISIBILITY, VISIBILITY_BY_OWNER, PLAN_STATUSES, PLAN_TRANSITIONS,
  GOAL_CATEGORIES, GOAL_CATEGORY_LABELS, GOAL_STATUSES, GOAL_TRANSITIONS, BLOCK_REASONS,
  ACTION_TYPES, ACTION_STATUSES, ACTION_TRANSITIONS,
  EVIDENCE_SOURCES, EVIDENCE_SOURCE_LABELS, REVIEWER_KINDS, REVIEWER_KIND_LABELS, SHARE_SCOPES,
  M21_LIMITS, GOAL_LIBRARY, GOAL_LIBRARY_NOTE, PLAN_TEMPLATES, TEMPLATE_NOTE,
  FORBIDDEN_DEVELOPMENT_NAMES, assertDevelopmentVocabulary, refusedClientFields,
  boundedText, parseDate, transitionAllowed, dueState, reviewDueState,
} from './shared.mjs';
import { TARGET_SOURCES, TARGET_OPERATORS, TARGET_STATES, TARGET_LIMITATION, validateTarget } from './targets.mjs';
import { validateEvidenceLink, EVIDENCE_LINK_FIELDS } from './evidence.mjs';
import { viewerFor, planAccess, canAssign, VIEWER_KINDS, CAPABILITIES } from './permissions.mjs';
import { collectPlan, buildDevelopmentPlan, planListItem, buildTimeline, TIMELINE_ACTIONS, PLAN_LIMITATION } from './plan.mjs';
import { buildGoalSnapshots, validateReview, validateSupersession, pageReviews } from './reviews.mjs';
import { guardRev, bumpRev } from '../m181/concurrency.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { metrics } from '../m13/enterprise.mjs';

/** How close together two identical creates must be to count as one retry. */
const IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * The M21 migration. Additive, idempotent, and — the point of §156/§157 —
 * the ONLY thing that creates these collections.
 *
 * M20 found `db.trials` had never been created by anything but the demo seed,
 * so a snapshot restored without it would have thrown on the first read. Every
 * store below is created here, at boot, on every boot, seeded or not, and the
 * acceptance suite proves it by booting with an empty data directory and
 * reading each one before anything writes.
 */
export function migrateM21(db) {
  db.developmentPlans ??= [];
  db.developmentGoals ??= [];
  db.developmentActions ??= [];
  db.developmentEvidenceLinks ??= [];
  db.developmentReviews ??= [];
}

export const M21_STORES = Object.freeze([
  'developmentPlans', 'developmentGoals', 'developmentActions',
  'developmentEvidenceLinks', 'developmentReviews',
]);

export function registerDevelopment(ctx) {
  const {
    db, nextId, persistNow, notify, broadcast, findPlayer, orgCanSee, isLead,
    orgRouter, playerRouter, guardianRouter, audit, isAdult,
  } = ctx;
  migrateM21(db);

  // Boot assertion. A development server whose own vocabulary has drifted
  // towards a rating does not start.
  const vocabulary = assertDevelopmentVocabulary();

  metrics.development = {
    development_plan_created: 0,
    development_goal_created: 0,
    development_action_completed: 0,
    development_review_submitted: 0,
    development_evidence_linked: 0,
    development_idempotent_retries: 0,
    policyVersion: DEVELOPMENT_POLICY_VERSION,
  };
  const vmetric = (k, n = 1) => { metrics.development[k] = (metrics.development[k] ?? 0) + n; };

  const now = () => Date.now();
  const limited = (action, keyPart) => !!ctx.rateLimit?.limited(action, keyPart);

  // ------------------------------------------------------------- primitives

  /**
   * Every event M21 emits is organisation-private and carries ids only.
   *
   * The names are written out as literal `broadcast('…')` call sites rather
   * than dispatched from a variable. That is deliberate: the M18.2 suite greps
   * the server tree for literal call sites and fails if they disagree with
   * `EMITTED_EVENTS`, and an event sent through a variable is invisible to
   * that check — and to anyone grepping for where a name is used.
   */
  const EMITTERS = Object.freeze({
    development_plan_created: (p) => broadcast('development_plan_created', p),
    development_plan_updated: (p) => broadcast('development_plan_updated', p),
    development_plan_completed: (p) => broadcast('development_plan_completed', p),
    development_goal_created: (p) => broadcast('development_goal_created', p),
    development_goal_updated: (p) => broadcast('development_goal_updated', p),
    development_action_completed: (p) => broadcast('development_action_completed', p),
    development_evidence_linked: (p) => broadcast('development_evidence_linked', p),
    development_review_submitted: (p) => broadcast('development_review_submitted', p),
  });

  const emit = (event, orgId, payload) => {
    if (!orgId) return;
    const send = EMITTERS[event];
    // An unregistered development event is a bug in this module, not a thing
    // to silently drop: the registry already fails closed, and so does this.
    if (!send) throw new Error(`M21 tried to emit unregistered event "${event}".`);
    send({ orgId, ...payload });
  };

  /** Organisations that should be told about a change to this plan. */
  const audienceOrgs = (plan) => (plan.owner.kind === 'org'
    ? [plan.owner.orgId]
    : (plan.visibility === 'shared_with_org' ? (plan.sharedWithOrgIds ?? []) : []));

  const emitAll = (event, plan, payload) => {
    for (const orgId of audienceOrgs(plan)) emit(event, orgId, { planId: plan.id, ...payload });
  };

  /**
   * Tell a person something happened, through the preference-aware channel.
   * `development` is one notification type mapping to one category, so a
   * person who does not want development mail turns off one switch (§81).
   */
  const tellPlayer = (plan, text) => {
    const p = findPlayer(plan.playerId);
    if (!p) return;
    if (isAdult(p)) notify({ kind: 'player', id: p.id }, 'development', text);
    else if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'development', text);
  };
  const tellOrg = (orgId, text) => {
    for (const u of db.users.filter((x) => x.orgId === orgId && !x.removedAt)) {
      notify({ kind: 'org_user', id: u.id }, 'development', text);
    }
  };

  const actorOf = (viewer, req) => {
    switch (viewer.kind) {
      case 'player_self': return { kind: 'player', id: req.player.id, name: req.player.name };
      case 'guardian': return { kind: 'guardian', id: req.guardian.id, name: req.guardian.name ?? null };
      default: return { kind: 'org', id: req.orgUser.id, name: req.orgUser.name };
    }
  };

  const writeHistory = (record, actor, action, detail = null) =>
    audit(record, actor.kind, actor.id, actor.name, action, detail);

  /**
   * A create that is the same create, by the same actor, moments ago, is a
   * retry rather than a second record (§109).
   */
  const recentDuplicate = (list, match, at) =>
    list.find((r) => at - (r.createdAt ?? 0) < IDEMPOTENCY_WINDOW_MS && match(r)) ?? null;

  /** Refuse a body that asserts something the server derives (§93). */
  const refuseDerived = (req, res) => {
    const bad = refusedClientFields(req.body);
    if (!bad.length) return false;
    res.status(400).json({
      error: 'CLIENT_CANNOT_ASSERT',
      fields: bad,
      detail: 'These are derived by ScoutBox from the records themselves and cannot be sent by a client.',
    });
    return true;
  };

  // ------------------------------------------------------------ resolution

  /**
   * Resolve a plan for this request, or answer it.
   *
   * Authorisation comes before existence in the ANSWER even though the lookup
   * has to come first: a viewer without access gets 404, so a plan id cannot
   * be probed for existence from outside (§78/§79).
   */
  function resolvePlan(req, res, planId, viewer) {
    const bundle = collectPlan(db, planId);
    const notFound = () => {
      res.status(404).json({ error: 'DEVELOPMENT_PLAN_NOT_FOUND', message: 'No such development plan.' });
      return null;
    };
    if (!bundle) return notFound();
    const player = findPlayer(bundle.plan.playerId);
    if (!player) return notFound();
    const subject = { ...player, isMinor: !isAdult(player) };
    const access = planAccess(viewer, bundle.plan, { player: subject, orgCanSee, isLead });
    if (!access.read) return notFound();
    return { ...bundle, player: subject, access, viewer };
  }

  const requireCap = (res, access, cap, detail) => {
    if (access[cap]) return true;
    res.status(403).json({ error: 'DEVELOPMENT_NOT_PERMITTED', capability: cap, message: detail });
    return false;
  };

  const project = (bundle, viewer) => buildDevelopmentPlan({
    db, planId: bundle.plan.id, player: bundle.player, viewer, access: bundle.access,
    orgCanSee, now: now(), collected: bundle,
  });

  const touch = (plan, actor) => {
    plan.updatedAt = now();
    bumpRev(plan, { by: { id: actor.id, name: actor.name } });
  };

  // ------------------------------------------------------------- catalogue

  /**
   * What the Hub is, and what it refuses to be, served from the server's own
   * vocabulary so a client renders definitions rather than carrying a copy
   * that drifts. The M20 pattern, for the same reason.
   */
  const catalogue = () => ({
    policyVersion: DEVELOPMENT_POLICY_VERSION,
    principle: DEVELOPMENT_PRINCIPLE,
    limitation: PLAN_LIMITATION,
    plan: { ownerKinds: PLAN_OWNER_KINDS, visibility: PLAN_VISIBILITY, visibilityByOwner: VISIBILITY_BY_OWNER, statuses: PLAN_STATUSES, transitions: PLAN_TRANSITIONS },
    goal: {
      categories: GOAL_CATEGORIES, categoryLabels: GOAL_CATEGORY_LABELS,
      statuses: GOAL_STATUSES, transitions: GOAL_TRANSITIONS,
      blockReasons: BLOCK_REASONS, achievedMeaning: ACHIEVED_MEANING,
      // Said in the catalogue, not only in a document: the two vocabularies
      // §13 and §48 offered conditionally are absent, and this is why.
      omitted: {
        categories: ['availability_rehabilitation'],
        blockReasons: ['injury_or_unavailable'],
        reason: 'ScoutBox has no safe vocabulary, consent model or retention rule for health information, so it does not offer a structured field that invites one. A blocked goal can say “other” in the author’s own words.',
      },
    },
    action: { types: ACTION_TYPES, statuses: ACTION_STATUSES, transitions: ACTION_TRANSITIONS },
    evidence: { sources: EVIDENCE_SOURCES, sourceLabels: EVIDENCE_SOURCE_LABELS },
    target: { sources: TARGET_SOURCES, operators: TARGET_OPERATORS, states: TARGET_STATES, limitation: TARGET_LIMITATION },
    review: { reviewerKinds: REVIEWER_KINDS, reviewerKindLabels: REVIEWER_KIND_LABELS, shareScopes: SHARE_SCOPES, appendOnly: true },
    timeline: { actions: Object.keys(TIMELINE_ACTIONS) },
    goalLibrary: { items: GOAL_LIBRARY, note: GOAL_LIBRARY_NOTE },
    templates: { items: PLAN_TEMPLATES, note: TEMPLATE_NOTE },
    limits: M21_LIMITS,
    viewerKinds: VIEWER_KINDS,
    capabilities: CAPABILITIES,
    reminders: {
      scheduler: 'none',
      // The M19 honesty standard, applied to dates (§84/§85).
      note: 'Due and overdue are worked out when you open the page. ScoutBox has no background scheduler in this build and does not send reminders while the app is closed.',
    },
    neverBuilt: {
      names: FORBIDDEN_DEVELOPMENT_NAMES,
      note: 'These do not exist in ScoutBox and are not planned. Development here is objective-specific, or it is nothing.',
    },
    vocabularyCheck: vocabulary.counts,
  });

  // ------------------------------------------------------------ validation

  function validatePlanBody(body, { ownerKind, existing = null }) {
    const title = boundedText(body?.title ?? existing?.title, M21_LIMITS.titleMax, { field: 'title' });
    if (title.error) return title;
    if (!title.value) return { error: 'TITLE_REQUIRED', detail: 'A development plan needs a title.' };

    const allowed = VISIBILITY_BY_OWNER[ownerKind];
    const visibility = body?.visibility ?? existing?.visibility ?? allowed[0];
    if (!allowed.includes(visibility)) {
      return {
        error: 'PLAN_VISIBILITY_INVALID', allowed, received: visibility,
        detail: ownerKind === 'org'
          ? 'A club plan is either kept inside the club or made visible to the player. It cannot be shared with another club.'
          : 'A player’s plan is private, visible to the guardian, or shared with named clubs. It cannot be marked club-private.',
      };
    }

    const start = parseDate(body?.startDate ?? existing?.startDate, { field: 'startDate' });
    if (start.error) return start;
    const nextReview = parseDate(body?.nextReviewAt ?? existing?.nextReviewAt, { field: 'nextReviewAt' });
    if (nextReview.error) return nextReview;
    const end = parseDate(body?.endDate ?? existing?.endDate, { field: 'endDate' });
    if (end.error) return end;

    // Dates that describe an impossible interval are refused, not reordered.
    if (start.value != null && end.value != null && end.value < start.value) {
      return { error: 'DATE_INTERVAL_INVALID', detail: 'The end date cannot be before the start date.' };
    }
    if (start.value != null && nextReview.value != null && nextReview.value < start.value) {
      return { error: 'DATE_INTERVAL_INVALID', detail: 'The next review cannot be scheduled before the plan starts.' };
    }

    let templateId = body?.templateId ?? existing?.templateId ?? null;
    if (templateId != null && !PLAN_TEMPLATES.some((t) => t.id === templateId)) {
      return { error: 'TEMPLATE_UNKNOWN', allowed: PLAN_TEMPLATES.map((t) => t.id), detail: `Unknown template "${templateId}".` };
    }

    return { value: { title: title.value, visibility, startDate: start.value, nextReviewAt: nextReview.value, endDate: end.value, templateId } };
  }

  function validateGoalBody(body, { existing = null }) {
    const title = boundedText(body?.title ?? existing?.title, M21_LIMITS.titleMax, { field: 'title' });
    if (title.error) return title;
    if (!title.value) return { error: 'TITLE_REQUIRED', detail: 'A development goal needs a title.' };

    const description = boundedText(body?.description ?? existing?.description, M21_LIMITS.descriptionMax, { field: 'description' });
    if (description.error) return description;

    const category = body?.category ?? existing?.category;
    if (!GOAL_CATEGORIES.includes(category)) {
      return { error: 'GOAL_CATEGORY_UNKNOWN', allowed: GOAL_CATEGORIES, received: category ?? null, detail: `Unknown goal category "${category ?? ''}".` };
    }

    const targetDate = parseDate(body?.targetDate ?? existing?.targetDate, { field: 'targetDate' });
    if (targetDate.error) return targetDate;

    let target = existing?.target ?? null;
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'target')) {
      const t = validateTarget(body.target);
      if (t.error) return t;
      target = t.value;
    }

    return { value: { title: title.value, description: description.value, category, targetDate: targetDate.value, target } };
  }

  function validateActionBody(body, { plan, player, existing = null }) {
    const title = boundedText(body?.title ?? existing?.title, M21_LIMITS.titleMax, { field: 'title' });
    if (title.error) return title;
    if (!title.value) return { error: 'TITLE_REQUIRED', detail: 'An action needs a title.' };

    const type = body?.type ?? existing?.type;
    if (!ACTION_TYPES.includes(type)) {
      return { error: 'ACTION_TYPE_UNKNOWN', allowed: ACTION_TYPES, received: type ?? null, detail: `Unknown action type "${type ?? ''}".` };
    }

    const dueAt = parseDate(body?.dueAt ?? existing?.dueAt, { field: 'dueAt' });
    if (dueAt.error) return dueAt;
    if (dueAt.value != null && plan.startDate != null && dueAt.value < plan.startDate) {
      return { error: 'DATE_INTERVAL_INVALID', detail: 'An action cannot be due before the plan starts.' };
    }

    let assignee = existing?.assignee ?? null;
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'assignee')) {
      const a = canAssign({ assignee: body.assignee, plan, player, db });
      if (a.error) return a;
      assignee = a.value;
    }

    return { value: { title: title.value, type, dueAt: dueAt.value, assignee } };
  }

  // ------------------------------------------------------------- the routes

  /**
   * The same surface on three routers. Mounting once rather than three times
   * is not only brevity: it means a player, a guardian and a coach are checked
   * by the same code, so an authorisation rule cannot be right on two of them
   * and forgotten on the third.
   */
  function mount(router, { viewerOf, ownerKindFor, subjectFor, rateKeyFor }) {
    const V = (req) => viewerOf(req);

    router.get('/development/catalogue', (_req, res) => res.json(catalogue()));

    // ---- list
    router.get('/development/plans', (req, res) => {
      const viewer = V(req);
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), M21_LIMITS.listPageMax);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const status = req.query.status ? String(req.query.status) : null;
      if (status && !PLAN_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'PLAN_STATUS_UNKNOWN', allowed: PLAN_STATUSES });
      }
      const playerFilter = req.query.playerId ? String(req.query.playerId) : null;

      const rows = [];
      for (const plan of db.developmentPlans) {
        if (playerFilter && plan.playerId !== playerFilter) continue;
        if (status && plan.status !== status) continue;
        const p = findPlayer(plan.playerId);
        if (!p) continue;
        const subject = { ...p, isMinor: !isAdult(p) };
        const access = planAccess(viewer, plan, { player: subject, orgCanSee, isLead });
        if (!access.read) continue;
        const goals = db.developmentGoals.filter((g) => g.planId === plan.id);
        const actions = db.developmentActions.filter((a) => a.planId === plan.id);
        rows.push(planListItem({ plan, player: subject, goals, actions, now: now() }));
      }
      // Stable: most recently updated first, id as the tie-break.
      rows.sort((a, b) => b.updatedAt - a.updatedAt || String(a.id).localeCompare(String(b.id)));
      res.set('X-ScoutBox-Ordering', 'recently_updated_then_id');
      res.json({
        // The count is of plans THIS viewer may read. A club never learns how
        // many plans a player has elsewhere (§72).
        total: rows.length, limit, offset,
        items: rows.slice(offset, offset + limit),
        note: 'Plans you can see. ScoutBox does not report how many other plans exist.',
      });
    });

    // ---- create
    router.post('/development/plans', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      if (limited('development_plan_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_plan_write'));

      const subject = subjectFor(req, res);
      if (!subject) return undefined;
      const { player, minorRefusal } = subject;
      if (minorRefusal) return res.status(403).json(minorRefusal);

      const ownerKind = ownerKindFor(req);
      const parsed = validatePlanBody(req.body, { ownerKind });
      if (parsed.error) return res.status(400).json(parsed);

      // §64: a draft may be empty; an active plan may not. Decided explicitly
      // rather than left to whichever route happened to check.
      const goalBodies = Array.isArray(req.body?.goals) ? req.body.goals : [];
      const wantsActive = String(req.body?.status ?? 'draft') === 'active';
      if (!PLAN_STATUSES.includes(String(req.body?.status ?? 'draft'))) {
        return res.status(400).json({ error: 'PLAN_STATUS_UNKNOWN', allowed: ['draft', 'active'] });
      }
      if (wantsActive && !goalBodies.length) {
        return res.status(400).json({ error: 'ACTIVE_PLAN_NEEDS_A_GOAL', detail: 'An active plan needs at least one goal. Save it as a draft if you are not ready.' });
      }
      if (goalBodies.length > M21_LIMITS.goalsPerPlan) {
        return res.status(400).json({ error: 'TOO_MANY_GOALS', max: M21_LIMITS.goalsPerPlan });
      }

      const ownerOrgId = ownerKind === 'org' ? req.org.id : null;
      const activeCount = db.developmentPlans.filter((p) => p.playerId === player.id
        && p.owner.kind === ownerKind && (p.owner.orgId ?? null) === ownerOrgId
        && !['archived', 'completed'].includes(p.status)).length;
      if (activeCount >= M21_LIMITS.activePlansPerOwner) {
        return res.status(400).json({ error: 'TOO_MANY_ACTIVE_PLANS', max: M21_LIMITS.activePlansPerOwner, detail: 'Complete or archive an existing plan first.' });
      }

      const actor = actorOf(viewer, req);
      const at = now();
      const dup = recentDuplicate(
        db.developmentPlans.filter((p) => p.playerId === player.id),
        (p) => p.title === parsed.value.title && p.createdBy?.id === actor.id && p.owner.kind === ownerKind && (p.owner.orgId ?? null) === ownerOrgId,
        at,
      );
      if (dup) {
        vmetric('development_idempotent_retries');
        const bundle = resolvePlan(req, res, dup.id, viewer);
        if (!bundle) return undefined;
        return res.status(200).json({ ...project(bundle, viewer), idempotent: true });
      }

      // Goals are validated BEFORE the plan is written, so a bad third goal
      // does not leave a half-built plan behind.
      const prepared = [];
      for (const gb of goalBodies) {
        const g = validateGoalBody(gb, {});
        if (g.error) return res.status(400).json(g);
        prepared.push(g.value);
      }

      const plan = {
        id: nextId('devplan'),
        playerId: player.id,
        owner: { kind: ownerKind, orgId: ownerOrgId, orgName: ownerKind === 'org' ? req.org.name : null },
        createdBy: actor,
        title: parsed.value.title,
        status: wantsActive ? 'active' : 'draft',
        visibility: parsed.value.visibility,
        sharedWithOrgIds: [],
        startDate: parsed.value.startDate ?? at,
        nextReviewAt: parsed.value.nextReviewAt,
        endDate: parsed.value.endDate,
        templateId: parsed.value.templateId,
        // The M12 bridge (§57): a plan may record where the idea came from.
        // Recording an origin is not adopting the record — the objective and
        // its Passport projection are untouched.
        originObjectiveId: originObjectiveFor(req.body?.originObjectiveId, player, res),
        originTrialId: null,
        createdAt: at, updatedAt: at,
        rev: 1, revAt: at, revBy: { userId: actor.id, name: actor.name },
        completedAt: null, archivedAt: null,
        history: [],
      };
      if (plan.originObjectiveId === false) return undefined; // already answered

      writeHistory(plan, actor, 'plan_created', { visibility: plan.visibility, owner: ownerKind });
      if (wantsActive) writeHistory(plan, actor, 'plan_activated');
      db.developmentPlans.push(plan);

      for (const g of prepared) {
        const goal = newGoal(plan, g, actor, at);
        db.developmentGoals.push(goal);
      }

      vmetric('development_plan_created');
      emitAll('development_plan_created', plan, {});
      if (plan.owner.kind === 'org' && plan.visibility === 'player_guardian') {
        tellPlayer(plan, `${req.org.name} shared a development plan with you: ${plan.title}`);
      }
      persistNow();
      const bundle = resolvePlan(req, res, plan.id, viewer);
      if (!bundle) return undefined;
      return res.status(201).json(project(bundle, viewer));
    });

    // ---- read
    router.get('/development/plans/:id', (req, res) => {
      const viewer = V(req);
      const bundle = resolvePlan(req, res, req.params.id, viewer);
      if (!bundle) return undefined;
      res.set('X-ScoutBox-Ordering', 'created_then_id');
      return res.json(project(bundle, viewer));
    });

    // ---- edit
    router.patch('/development/plans/:id', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const bundle = resolvePlan(req, res, req.params.id, viewer);
      if (!bundle) return undefined;
      const { plan, access } = bundle;
      if (!requireCap(res, access, 'manage', 'You cannot change this plan.')) return undefined;
      if (plan.status === 'archived') return res.status(409).json({ error: 'PLAN_ARCHIVED', detail: 'An archived plan is a historical record and cannot be changed. Its history is preserved.' });
      if (limited('development_plan_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_plan_write'));
      if (!guardRev(req, res, plan, { errorCode: 'DEVELOPMENT_PLAN_VERSION_CONFLICT', current: { planId: plan.id, status: plan.status } })) return undefined;

      const parsed = validatePlanBody(req.body, { ownerKind: plan.owner.kind, existing: plan });
      if (parsed.error) return res.status(400).json(parsed);

      const actor = actorOf(viewer, req);
      const visibilityChanged = parsed.value.visibility !== plan.visibility;
      Object.assign(plan, parsed.value);
      if (visibilityChanged) {
        writeHistory(plan, actor, 'plan_visibility_changed', { to: plan.visibility });
        // Narrowing a player-owned plan withdraws every share with it: a plan
        // that is no longer shared is no longer shared with anyone.
        if (plan.owner.kind === 'player' && plan.visibility !== 'shared_with_org' && (plan.sharedWithOrgIds ?? []).length) {
          for (const orgId of plan.sharedWithOrgIds) emit('development_plan_updated', orgId, { planId: plan.id });
          plan.sharedWithOrgIds = [];
          writeHistory(plan, actor, 'plan_unshared');
        }
      }
      touch(plan, actor);
      emitAll('development_plan_updated', plan, {});
      persistNow();
      return res.json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    // ---- status
    router.post('/development/plans/:id/status', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const bundle = resolvePlan(req, res, req.params.id, viewer);
      if (!bundle) return undefined;
      const { plan, goals, access } = bundle;
      if (!requireCap(res, access, 'manage', 'You cannot change this plan’s status.')) return undefined;
      if (limited('development_plan_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_plan_write'));

      const to = String(req.body?.status ?? '');
      if (!PLAN_STATUSES.includes(to)) return res.status(400).json({ error: 'PLAN_STATUS_UNKNOWN', allowed: PLAN_STATUSES });
      if (!transitionAllowed(PLAN_TRANSITIONS, plan.status, to)) {
        return res.status(409).json({
          error: 'PLAN_TRANSITION_INVALID', from: plan.status, to,
          allowed: PLAN_TRANSITIONS[plan.status],
          detail: `A ${plan.status} plan cannot become ${to}.`,
        });
      }
      if (to === 'active' && !goals.length) {
        return res.status(400).json({ error: 'ACTIVE_PLAN_NEEDS_A_GOAL', detail: 'An active plan needs at least one goal.' });
      }
      if (!guardRev(req, res, plan, { errorCode: 'DEVELOPMENT_PLAN_VERSION_CONFLICT', current: { planId: plan.id, status: plan.status } })) return undefined;

      const actor = actorOf(viewer, req);
      const from = plan.status;
      plan.status = to;
      if (to === 'completed') plan.completedAt = now();
      if (to === 'archived') plan.archivedAt = now();
      const ACTION_BY_STATUS = { active: 'plan_activated', paused: 'plan_paused', completed: 'plan_completed', archived: 'plan_archived' };
      writeHistory(plan, actor, ACTION_BY_STATUS[to] ?? 'plan_updated', { from, to });
      touch(plan, actor);
      emitAll(to === 'completed' ? 'development_plan_completed' : 'development_plan_updated', plan, {});
      persistNow();
      return res.json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    // ---- share with a named organisation (player-owned plans only)
    router.post('/development/plans/:id/share', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const bundle = resolvePlan(req, res, req.params.id, viewer);
      if (!bundle) return undefined;
      const { plan, player, access } = bundle;
      if (!requireCap(res, access, 'manage', 'You cannot change who this plan is shared with.')) return undefined;
      if (plan.owner.kind !== 'player') {
        return res.status(400).json({ error: 'SHARE_NOT_APPLICABLE', detail: 'A club plan is shared with the player by changing its visibility, not by sharing it with another club.' });
      }
      if (limited('development_plan_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_plan_write'));

      const orgId = String(req.body?.orgId ?? '');
      const org = db.orgs.find((o) => o.id === orgId);
      // The organisation must be one that can actually see this player.
      // Sharing with a club that cannot see the player would create access
      // the visibility rules deny everywhere else.
      if (!org || !orgCanSee(org, player)) {
        return res.status(404).json({ error: 'ORG_NOT_FOUND', detail: 'No such organisation is available to share with.' });
      }
      const revoke = req.body?.revoke === true;
      const actor = actorOf(viewer, req);
      plan.sharedWithOrgIds ??= [];

      if (revoke) {
        if (!plan.sharedWithOrgIds.includes(orgId)) return res.status(200).json({ ...project(bundle, viewer), idempotent: true });
        plan.sharedWithOrgIds = plan.sharedWithOrgIds.filter((x) => x !== orgId);
        writeHistory(plan, actor, 'plan_unshared', { kind: 'org' });
        emit('development_plan_updated', orgId, { planId: plan.id });
      } else {
        if (plan.visibility !== 'shared_with_org') {
          return res.status(400).json({ error: 'PLAN_NOT_SHAREABLE', detail: 'Set this plan’s visibility to “shared with clubs” before choosing which clubs can read it.' });
        }
        if (plan.sharedWithOrgIds.includes(orgId)) {
          vmetric('development_idempotent_retries');
          return res.status(200).json({ ...project(bundle, viewer), idempotent: true });
        }
        plan.sharedWithOrgIds.push(orgId);
        writeHistory(plan, actor, 'plan_shared', { kind: 'org' });
        emit('development_plan_created', orgId, { planId: plan.id });
        tellOrg(orgId, `${player.name} shared a development plan with your club.`);
      }
      touch(plan, actor);
      persistNow();
      return res.json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    // ---- goals
    router.post('/development/plans/:id/goals', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const bundle = resolvePlan(req, res, req.params.id, viewer);
      if (!bundle) return undefined;
      const { plan, goals, access } = bundle;
      if (!requireCap(res, access, 'writeGoals', 'You cannot add goals to this plan.')) return undefined;
      if (['archived', 'completed'].includes(plan.status)) {
        return res.status(409).json({ error: 'PLAN_NOT_EDITABLE', status: plan.status, detail: `A ${plan.status} plan cannot take new goals.` });
      }
      if (limited('development_item_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_item_write'));
      if (goals.length >= M21_LIMITS.goalsPerPlan) {
        return res.status(400).json({ error: 'TOO_MANY_GOALS', max: M21_LIMITS.goalsPerPlan, detail: 'A plan with twenty goals is a plan nobody will work through.' });
      }

      const parsed = validateGoalBody(req.body, {});
      if (parsed.error) return res.status(400).json(parsed);

      const actor = actorOf(viewer, req);
      const at = now();
      const dup = recentDuplicate(goals, (g) => g.title === parsed.value.title && g.createdBy?.id === actor.id, at);
      if (dup) {
        vmetric('development_idempotent_retries');
        return res.status(200).json({ ...project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer), idempotent: true });
      }

      const origin = originObjectiveFor(req.body?.originObjectiveId, bundle.player, res);
      if (origin === false) return undefined;
      const goal = newGoal(plan, { ...parsed.value, originObjectiveId: origin }, actor, at);
      db.developmentGoals.push(goal);
      touch(plan, actor);
      vmetric('development_goal_created');
      emitAll('development_goal_created', plan, { goalId: goal.id });
      if (plan.owner.kind === 'org' && plan.visibility === 'player_guardian') {
        tellPlayer(plan, `A new development goal was shared with you: ${goal.title}`);
      }
      persistNow();
      return res.status(201).json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    router.patch('/development/goals/:goalId', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const goal = db.developmentGoals.find((g) => g.id === req.params.goalId);
      if (!goal) return res.status(404).json({ error: 'DEVELOPMENT_GOAL_NOT_FOUND' });
      const bundle = resolvePlan(req, res, goal.planId, viewer);
      if (!bundle) return undefined;
      const { plan, access } = bundle;
      if (!requireCap(res, access, 'writeGoals', 'You cannot change this goal.')) return undefined;
      if (['archived', 'completed'].includes(plan.status)) {
        return res.status(409).json({ error: 'PLAN_NOT_EDITABLE', status: plan.status });
      }
      if (limited('development_item_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_item_write'));
      // Two coaches editing one goal is the case §70 exists for.
      // The conflict body carries the goal's id and status and NOT its title:
      // the other person's edit is content, and the caller reloads through its
      // own authorised read rather than learning it from a 409.
      if (!guardRev(req, res, goal, { errorCode: 'DEVELOPMENT_GOAL_VERSION_CONFLICT', current: { goalId: goal.id, status: goal.status } })) return undefined;

      const actor = actorOf(viewer, req);
      const at = now();

      // Status is its own transition, checked before anything else changes.
      let statusChanged = null;
      if (req.body?.status != null && req.body.status !== goal.status) {
        const to = String(req.body.status);
        if (!GOAL_STATUSES.includes(to)) return res.status(400).json({ error: 'GOAL_STATUS_UNKNOWN', allowed: GOAL_STATUSES });
        if (!transitionAllowed(GOAL_TRANSITIONS, goal.status, to)) {
          return res.status(409).json({
            error: 'GOAL_TRANSITION_INVALID', from: goal.status, to, allowed: GOAL_TRANSITIONS[goal.status],
            detail: goal.status === 'not_started' && to === 'achieved'
              ? 'A goal nobody started cannot have been achieved through this plan. Move it to in progress first.'
              : `A ${goal.status} goal cannot become ${to}.`,
          });
        }
        if (to === 'blocked') {
          const reason = String(req.body?.blockReason ?? '');
          if (!BLOCK_REASONS.includes(reason)) {
            return res.status(400).json({ error: 'BLOCK_REASON_UNKNOWN', allowed: BLOCK_REASONS, detail: 'A blocked goal needs a reason from the list. ScoutBox does not offer a health reason and does not record one.' });
          }
          const note = boundedText(req.body?.blockNote, M21_LIMITS.blockNoteMax, { field: 'blockNote' });
          if (note.error) return res.status(400).json(note);
          goal.blockReason = reason;
          goal.blockNote = note.value;
        } else {
          goal.blockReason = null;
          goal.blockNote = null;
        }
        statusChanged = { from: goal.status, to };
        goal.status = to;
        goal.completedAt = to === 'achieved' ? at : null;
      }

      const parsed = validateGoalBody(req.body, { existing: goal });
      if (parsed.error) return res.status(400).json(parsed);
      const targetChanged = JSON.stringify(parsed.value.target ?? null) !== JSON.stringify(goal.target ?? null);
      Object.assign(goal, parsed.value);
      goal.updatedAt = at;
      bumpRev(goal, { by: { id: actor.id, name: actor.name }, at });

      if (statusChanged) writeHistory(goal, actor, 'goal_status_changed', statusChanged);
      if (targetChanged && goal.target) writeHistory(goal, actor, 'goal_target_set', { protocolId: goal.target.protocolId });
      if (!statusChanged && !targetChanged) writeHistory(goal, actor, 'goal_updated');

      touch(plan, actor);
      emitAll('development_goal_updated', plan, { goalId: goal.id });
      if (statusChanged?.to === 'achieved' && plan.owner.kind === 'org' && plan.visibility === 'player_guardian') {
        tellPlayer(plan, `A development goal was marked achieved: ${goal.title}`);
      }
      persistNow();
      return res.json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    // ---- actions
    router.post('/development/goals/:goalId/actions', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const goal = db.developmentGoals.find((g) => g.id === req.params.goalId);
      if (!goal) return res.status(404).json({ error: 'DEVELOPMENT_GOAL_NOT_FOUND' });
      const bundle = resolvePlan(req, res, goal.planId, viewer);
      if (!bundle) return undefined;
      const { plan, actions, access, player } = bundle;
      if (!requireCap(res, access, 'writeGoals', 'You cannot add actions to this plan.')) return undefined;
      if (['archived', 'completed'].includes(plan.status)) return res.status(409).json({ error: 'PLAN_NOT_EDITABLE', status: plan.status });
      if (limited('development_item_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_item_write'));
      const mine = actions.filter((a) => a.goalId === goal.id);
      if (mine.length >= M21_LIMITS.actionsPerGoal) {
        return res.status(400).json({ error: 'TOO_MANY_ACTIONS', max: M21_LIMITS.actionsPerGoal });
      }

      const parsed = validateActionBody(req.body, { plan, player });
      if (parsed.error) return res.status(400).json(parsed);

      const actor = actorOf(viewer, req);
      const at = now();
      const dup = recentDuplicate(mine, (a) => a.title === parsed.value.title && a.createdBy?.id === actor.id, at);
      if (dup) {
        vmetric('development_idempotent_retries');
        return res.status(200).json({ ...project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer), idempotent: true });
      }

      const action = {
        id: nextId('devact'),
        planId: plan.id, goalId: goal.id, playerId: plan.playerId,
        type: parsed.value.type, title: parsed.value.title,
        dueAt: parsed.value.dueAt, assignee: parsed.value.assignee,
        status: 'todo',
        createdBy: actor, createdAt: at, updatedAt: at, completedAt: null,
        history: [],
      };
      writeHistory(action, actor, 'action_created', { kind: action.type });
      db.developmentActions.push(action);
      touch(plan, actor);
      persistNow();
      return res.status(201).json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    router.patch('/development/actions/:actionId', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const action = db.developmentActions.find((a) => a.id === req.params.actionId);
      if (!action) return res.status(404).json({ error: 'DEVELOPMENT_ACTION_NOT_FOUND' });
      const bundle = resolvePlan(req, res, action.planId, viewer);
      if (!bundle) return undefined;
      const { plan, access, player } = bundle;
      if (['archived', 'completed'].includes(plan.status)) return res.status(409).json({ error: 'PLAN_NOT_EDITABLE', status: plan.status });
      if (limited('development_item_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_item_write'));

      // A player may tick their OWN assigned action even on a club plan they
      // cannot otherwise edit — that is the point of assigning it to them.
      const assignedToViewer = action.assignee?.kind === 'player' && viewer.kind === 'player_self' && action.assignee.id === viewer.playerId;
      const assignedToGuardian = action.assignee?.kind === 'guardian' && viewer.kind === 'guardian' && action.assignee.id === viewer.guardianId;
      const mayTick = access.writeGoals || assignedToViewer || assignedToGuardian;
      if (!mayTick) return res.status(403).json({ error: 'DEVELOPMENT_NOT_PERMITTED', capability: 'writeGoals', message: 'You cannot change this action.' });

      const actor = actorOf(viewer, req);
      const at = now();
      let statusChanged = null;
      if (req.body?.status != null && req.body.status !== action.status) {
        const to = String(req.body.status);
        if (!ACTION_STATUSES.includes(to)) return res.status(400).json({ error: 'ACTION_STATUS_UNKNOWN', allowed: ACTION_STATUSES });
        if (!transitionAllowed(ACTION_TRANSITIONS, action.status, to)) {
          return res.status(409).json({ error: 'ACTION_TRANSITION_INVALID', from: action.status, to, allowed: ACTION_TRANSITIONS[action.status] });
        }
        statusChanged = { from: action.status, to };
        action.status = to;
        action.completedAt = to === 'done' ? at : null;
      }

      // A person who only holds the action can tick it; changing its title,
      // type, due date or assignee is still a plan edit.
      if (!access.writeGoals) {
        const editing = ['title', 'type', 'dueAt', 'assignee'].some((k) => Object.prototype.hasOwnProperty.call(req.body ?? {}, k));
        if (editing) return res.status(403).json({ error: 'DEVELOPMENT_NOT_PERMITTED', capability: 'writeGoals', message: 'You can mark this action done, but not change it.' });
      } else {
        const parsed = validateActionBody(req.body, { plan, player, existing: action });
        if (parsed.error) return res.status(400).json(parsed);
        Object.assign(action, parsed.value);
      }
      action.updatedAt = at;

      if (statusChanged) {
        writeHistory(action, actor, statusChanged.to === 'done' ? 'action_completed' : 'action_status_changed', statusChanged);
        if (statusChanged.to === 'done') {
          vmetric('development_action_completed');
          // The goal does NOT move. Completing an action is completing an
          // action (§123/G5) — no code path here touches goal.status.
          emitAll('development_action_completed', plan, { actionId: action.id });
          if (plan.owner.kind === 'org' && actor.kind !== 'org') tellOrg(plan.owner.orgId, `${player.name} completed a development action: ${action.title}`);
        }
      }
      touch(plan, actor);
      persistNow();
      return res.json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    // ---- evidence links
    const linkEvidence = (targetKind) => (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const holder = targetKind === 'goal'
        ? db.developmentGoals.find((g) => g.id === req.params.goalId)
        : db.developmentActions.find((a) => a.id === req.params.actionId);
      if (!holder) return res.status(404).json({ error: targetKind === 'goal' ? 'DEVELOPMENT_GOAL_NOT_FOUND' : 'DEVELOPMENT_ACTION_NOT_FOUND' });
      const bundle = resolvePlan(req, res, holder.planId, viewer);
      if (!bundle) return undefined;
      const { plan, links, access, player } = bundle;
      if (!requireCap(res, access, 'linkEvidence', 'You cannot link evidence to this plan.')) return undefined;
      if (['archived', 'completed'].includes(plan.status)) return res.status(409).json({ error: 'PLAN_NOT_EDITABLE', status: plan.status });
      if (limited('development_item_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_item_write'));

      const key = targetKind === 'goal' ? 'goalId' : 'actionId';
      const mine = links.filter((l) => l[key] === holder.id);
      if (mine.length >= M21_LIMITS.evidenceLinksPerTarget) {
        return res.status(400).json({ error: 'TOO_MANY_EVIDENCE_LINKS', max: M21_LIMITS.evidenceLinksPerTarget });
      }

      const parsed = validateEvidenceLink({
        sourceType: req.body?.sourceType, sourceId: req.body?.sourceId,
        db, player, viewer, orgCanSee, now: now(),
      });
      if (parsed.error) return res.status(parsed.error === 'EVIDENCE_NOT_FOUND' ? 404 : 400).json(parsed);

      // Linking the same evidence twice is one link, not two (§118#30).
      const existing = mine.find((l) => l.sourceType === parsed.value.sourceType && l.sourceId === parsed.value.sourceId);
      if (existing) {
        vmetric('development_idempotent_retries');
        return res.status(200).json({ ...project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer), idempotent: true });
      }

      const actor = actorOf(viewer, req);
      const at = now();
      const link = {
        id: nextId('devlink'),
        planId: plan.id,
        goalId: targetKind === 'goal' ? holder.id : null,
        actionId: targetKind === 'action' ? holder.id : null,
        playerId: plan.playerId,
        sourceType: parsed.value.sourceType,
        sourceId: parsed.value.sourceId,
        linkedByKind: actor.kind, linkedById: actor.id, linkedByName: actor.name,
        linkedAt: at,
      };
      db.developmentEvidenceLinks.push(link);
      writeHistory(holder, actor, 'evidence_linked', { kind: link.sourceType });
      touch(plan, actor);
      vmetric('development_evidence_linked');
      emitAll('development_evidence_linked', plan, { goalId: link.goalId, actionId: link.actionId });
      persistNow();
      return res.status(201).json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    };

    router.post('/development/goals/:goalId/evidence', linkEvidence('goal'));
    router.post('/development/actions/:actionId/evidence', linkEvidence('action'));

    router.delete('/development/evidence/:linkId', (req, res) => {
      const viewer = V(req);
      const link = db.developmentEvidenceLinks.find((l) => l.id === req.params.linkId);
      if (!link) return res.status(404).json({ error: 'EVIDENCE_LINK_NOT_FOUND' });
      const bundle = resolvePlan(req, res, link.planId, viewer);
      if (!bundle) return undefined;
      const { plan, goals, actions, access } = bundle;
      if (!requireCap(res, access, 'linkEvidence', 'You cannot change this plan’s evidence.')) return undefined;
      if (['archived', 'completed'].includes(plan.status)) return res.status(409).json({ error: 'PLAN_NOT_EDITABLE', status: plan.status });

      const actor = actorOf(viewer, req);
      db.developmentEvidenceLinks = db.developmentEvidenceLinks.filter((l) => l.id !== link.id);
      const holder = link.goalId ? goals.find((g) => g.id === link.goalId) : actions.find((a) => a.id === link.actionId);
      if (holder) writeHistory(holder, actor, 'evidence_unlinked', { kind: link.sourceType });
      touch(plan, actor);
      persistNow();
      return res.json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    // ---- reviews
    router.get('/development/plans/:id/reviews', (req, res) => {
      const viewer = V(req);
      const bundle = resolvePlan(req, res, req.params.id, viewer);
      if (!bundle) return undefined;
      const full = project(bundle, viewer);
      const page = pageReviews(full.reviews, { limit: req.query.limit, cursor: req.query.cursor });
      if (page.error) return res.status(400).json(page);
      return res.json({ ...page.value, note: 'Reviews are append-only. A correction appears as a new review that names the one it replaces.' });
    });

    router.post('/development/plans/:id/reviews', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const bundle = resolvePlan(req, res, req.params.id, viewer);
      if (!bundle) return undefined;
      const { plan, goals, actions, links, reviews, access, player } = bundle;
      if (plan.status === 'archived') return res.status(409).json({ error: 'PLAN_ARCHIVED', detail: 'An archived plan cannot take a new review.' });
      if (limited('development_review_write', rateKeyFor(req))) return res.status(429).json(rateLimitedBody('development_review_write'));

      const parsed = validateReview({ body: req.body, access, viewer, now: now() });
      if (parsed.error) return res.status(parsed.error === 'REVIEW_NOT_PERMITTED' ? 403 : 400).json(parsed);

      // A correction is a new review that names the one it replaces (§34).
      let superseded = null;
      if (req.body?.supersedes) {
        const target = reviews.find((r) => r.id === String(req.body.supersedes));
        const check = validateSupersession({ target, plan, reviews, viewer, access });
        if (check.error) return res.status(check.error === 'REVIEW_NOT_FOUND' ? 404 : 409).json(check);
        superseded = check.value;
      }

      const actor = actorOf(viewer, req);
      const at = now();
      const dup = recentDuplicate(reviews, (r) => r.reviewedBy?.id === actor.id && r.sharedSummary === parsed.value.sharedSummary && r.internalNote === parsed.value.internalNote, at);
      if (dup) {
        vmetric('development_idempotent_retries');
        return res.status(200).json({ ...project(bundle, viewer), idempotent: true });
      }

      const attempts = db.combineAttempts.filter((a) => a.playerId === plan.playerId);
      const sessions = new Map(db.boxSessions.filter((s) => s.playerId === plan.playerId).map((s) => [s.id, s]));
      const review = {
        id: nextId('devrev'),
        planId: plan.id, playerId: plan.playerId,
        reviewerKind: parsed.value.reviewerKind,
        reviewedBy: actor,
        orgId: actor.kind === 'org' ? req.org.id : null,
        reviewedAt: at,
        sharedSummary: parsed.value.sharedSummary,
        internalNote: parsed.value.internalNote,
        goalSnapshots: buildGoalSnapshots({ goals, actions, links, attempts, sessions }),
        nextReviewAt: parsed.value.nextReviewAt,
        sharedWithPlayerAt: parsed.value.shareWithPlayer ? at : null,
        shareScopes: parsed.value.shareScopes,
        supersedes: superseded?.id ?? null,
        supersededBy: null,
        createdAt: at,
        history: [],
      };
      // A player's own reflection is theirs to read back, always.
      if (review.reviewerKind !== 'coach_review') review.sharedWithPlayerAt = at;

      writeHistory(review, actor, 'review_submitted', { kind: review.reviewerKind, note: !!review.internalNote });
      if (superseded) {
        superseded.supersededBy = review.id;
        writeHistory(superseded, actor, 'review_superseded');
      }
      if (review.sharedWithPlayerAt && review.reviewerKind === 'coach_review') writeHistory(review, actor, 'review_shared');
      db.developmentReviews.push(review);

      if (parsed.value.nextReviewAt != null) plan.nextReviewAt = parsed.value.nextReviewAt;
      touch(plan, actor);

      vmetric('development_review_submitted');
      emitAll('development_review_submitted', plan, { reviewId: review.id });
      if (review.reviewerKind === 'coach_review' && review.sharedWithPlayerAt) {
        tellPlayer(plan, 'A development review was shared with you.');
      }
      if (review.reviewerKind !== 'coach_review' && plan.owner.kind === 'org') {
        tellOrg(plan.owner.orgId, `${player.name} added a development reflection.`);
      }
      persistNow();
      return res.status(201).json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    /** Share an already-submitted review's summary. The note is never shared. */
    router.post('/development/reviews/:reviewId/share', (req, res) => {
      if (refuseDerived(req, res)) return;
      const viewer = V(req);
      const review = db.developmentReviews.find((r) => r.id === req.params.reviewId);
      if (!review) return res.status(404).json({ error: 'REVIEW_NOT_FOUND' });
      const bundle = resolvePlan(req, res, review.planId, viewer);
      if (!bundle) return undefined;
      const { plan, access } = bundle;
      if (!access.readInternal) return res.status(403).json({ error: 'DEVELOPMENT_NOT_PERMITTED', message: 'Only the organisation that wrote this review can share it.' });
      if (!review.sharedSummary) return res.status(400).json({ error: 'SHARE_NEEDS_SUMMARY', detail: 'This review has no summary to share. The internal note is never shared.' });
      if (review.sharedWithPlayerAt) {
        vmetric('development_idempotent_retries');
        return res.status(200).json({ ...project(bundle, viewer), idempotent: true });
      }
      const asked = Array.isArray(req.body?.scopes) && req.body.scopes.length ? req.body.scopes.map(String) : ['summary'];
      const unknown = asked.filter((s) => !SHARE_SCOPES.includes(s));
      if (unknown.length) return res.status(400).json({ error: 'SHARE_SCOPE_UNKNOWN', allowed: SHARE_SCOPES });

      const actor = actorOf(viewer, req);
      review.sharedWithPlayerAt = now();
      review.shareScopes = [...new Set(asked)];
      writeHistory(review, actor, 'review_shared');
      touch(plan, actor);
      tellPlayer(plan, 'A development review was shared with you.');
      persistNow();
      return res.json(project(resolvePlan(req, res, plan.id, viewer) ?? bundle, viewer));
    });

    // ---- history
    router.get('/development/plans/:id/history', (req, res) => {
      const viewer = V(req);
      const bundle = resolvePlan(req, res, req.params.id, viewer);
      if (!bundle) return undefined;
      const all = buildTimeline({ ...bundle, access: bundle.access });
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), M21_LIMITS.historyPageMax);
      let start = 0;
      if (req.query.cursor) {
        const idx = all.findIndex((r) => r.id === String(req.query.cursor));
        if (idx < 0) return res.status(400).json({ error: 'HISTORY_CURSOR_INVALID', detail: 'That page no longer exists — start again from the first page.' });
        start = idx + 1;
      }
      const page = all.slice(start, start + limit);
      res.set('X-ScoutBox-Ordering', 'newest_first_then_id');
      return res.json({
        items: page,
        total: all.length,
        nextCursor: start + limit < all.length ? page[page.length - 1]?.id ?? null : null,
        note: 'Meaningful development events only. Reads and saves that changed nothing are not recorded.',
      });
    });
  }

  // ---- helpers used by the mounted routes

  function newGoal(plan, v, actor, at) {
    const goal = {
      id: nextId('devgoal'),
      planId: plan.id, playerId: plan.playerId,
      title: v.title, description: v.description ?? null, category: v.category,
      status: 'not_started', blockReason: null, blockNote: null,
      targetDate: v.targetDate ?? null,
      target: v.target ?? null,
      originObjectiveId: v.originObjectiveId ?? null,
      createdBy: actor, createdAt: at, updatedAt: at, completedAt: null,
      rev: 1, revAt: at, revBy: { userId: actor.id, name: actor.name },
      history: [],
    };
    writeHistory(goal, actor, 'goal_created', { kind: goal.category });
    if (goal.target) writeHistory(goal, actor, 'goal_target_set', { protocolId: goal.target.protocolId });
    return goal;
  }

  /**
   * The M12 bridge. A plan or goal may record that it grew out of an existing
   * development objective — by id, on explicit user action, and only for this
   * player. Nothing about the M12 record, its routes or its Passport
   * projection changes; M21 reads an id and stores an id.
   */
  function originObjectiveFor(raw, player, res) {
    if (raw == null || raw === '') return null;
    const rec = (db.devObjectives ?? []).find((o) => o.id === String(raw) && o.playerId === player.id);
    if (!rec) {
      res.status(404).json({ error: 'DEVELOPMENT_OBJECTIVE_NOT_FOUND', detail: 'No such development objective exists for this player.' });
      return false;
    }
    return rec.id;
  }

  // --------------------------------------------------------------- mounting

  mount(playerRouter, {
    viewerOf: (req) => ({ kind: 'player_self', playerId: req.player.id, isMinor: !!req.playerIsMinor }),
    ownerKindFor: () => 'player',
    rateKeyFor: (req) => `player:${req.player.id}`,
    subjectFor: (req, _res) => {
      const player = { ...req.player, isMinor: !!req.playerIsMinor };
      if (req.playerIsMinor) {
        return {
          player,
          // The existing safeguarding model, unchanged: a minor's records are
          // created and managed by their guardian (§74).
          minorRefusal: {
            error: 'GUARDIAN_MANAGED',
            message: 'A guardian creates and manages development plans for a player under 18. You can read the plan here.',
          },
        };
      }
      return { player };
    },
  });

  mount(guardianRouter, {
    viewerOf: (req) => ({ kind: 'guardian', guardianId: req.guardian.id, childIds: req.guardian.childIds ?? [] }),
    ownerKindFor: () => 'player',
    rateKeyFor: (req) => `guardian:${req.guardian.id}`,
    subjectFor: (req, res) => {
      const id = String(req.body?.playerId ?? '');
      const p = findPlayer(id);
      if (!p || !(req.guardian.childIds ?? []).includes(p.id)) {
        res.status(404).json({ error: 'PLAYER_NOT_FOUND', message: 'No such player is in your care.' });
        return null;
      }
      if (isAdult(p)) {
        res.status(403).json({ error: 'PLAYER_IS_ADULT', message: 'This player manages their own development plans.' });
        return null;
      }
      return { player: { ...p, isMinor: true } };
    },
  });

  mount(orgRouter, {
    viewerOf: (req) => ({
      kind: req.org.level === 'grassroots' ? 'grassroots_staff' : 'org_staff',
      org: req.org, orgUser: req.orgUser, isLead: isLead(req.orgUser),
    }),
    ownerKindFor: () => 'org',
    rateKeyFor: (req) => `org:${req.org.id}`,
    subjectFor: (req, res) => {
      const p = findPlayer(String(req.body?.playerId ?? ''));
      // Not visible is not found. A club cannot use plan creation to discover
      // that a player exists outside its wall.
      if (!p || !orgCanSee(req.org, p)) {
        res.status(404).json({ error: 'PLAYER_NOT_FOUND', message: 'No such player is available to your organisation.' });
        return null;
      }
      return { player: { ...p, isMinor: !isAdult(p) } };
    },
  });

  return {
    developmentCatalogue: catalogue,
    developmentStores: M21_STORES,
    developmentVocabulary: vocabulary,
    evidenceLinkFields: EVIDENCE_LINK_FIELDS,
  };
}
