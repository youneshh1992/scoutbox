/**
 * M21 — Development Hub: the vocabulary, the limits, and the rules that are
 * pure functions of a record.
 *
 * Everything in this file is data or a pure function. No route, no store, no
 * clock beyond the one it is handed. That matters because the whole milestone
 * rests on a small number of decisions that must be readable in one place and
 * asserted at boot rather than discovered in production:
 *
 *   • what a Plan, a Goal and an Action may be — status by status
 *   • which transitions are possible, so "invalid transition" is a refusal
 *     with a reason rather than a silently accepted write
 *   • what M21 will never build
 *
 * The last one is the point of the milestone. ScoutBox documents and
 * coordinates development; it does not claim to measure a player's worth,
 * ceiling or future. There is no Development Score here and no place to put
 * one: `assertDevelopmentVocabulary()` runs at boot and refuses to start a
 * development server whose own vocabulary has drifted towards a rating.
 */

import { parseDateOrInstant } from '../temporal.mjs';

export const DEVELOPMENT_POLICY_VERSION = 1;

/**
 * The central rule, carried on the wire so a client renders the server's
 * sentence rather than its own paraphrase of it.
 */
export const DEVELOPMENT_PRINCIPLE =
  'Document and coordinate development. ScoutBox does not measure a player’s worth, ceiling or future.';

// ---------------------------------------------------------------- never built

/**
 * Names M21 refuses. Not a lint list — `assertDevelopmentVocabulary()` scans
 * every label this module exports against it at boot, and the routes refuse a
 * client-supplied field whose name matches one.
 *
 * They are refused for one reason each, and the reason is the same reason:
 * a single blended figure invites a decision about a person that the figure
 * cannot support. "82" answers a question nobody can ask honestly.
 */
export const FORBIDDEN_DEVELOPMENT_NAMES = Object.freeze([
  'Development Score', 'Potential Score', 'Improvement Score',
  'Readiness Score', 'Growth Score', 'Academy Score',
  'Player Progress Rating', 'Player Rating', 'Development Rating',
  'Development Ranking', 'Coach Ranking',
]);

/**
 * The same refusal in identifier form. Kept separate from the names above for
 * a reason that is easy to get wrong: the copy scan looks for the NAMES in
 * prose, and prose is allowed — required, in fact — to say the word while
 * denying it. "ScoutBox does not measure a player's ceiling" must not fail a
 * check for the field `ceiling`. Names are scanned in copy; identifiers are
 * checked against payload keys.
 */
export const FORBIDDEN_FIELD_NAMES = Object.freeze([
  'developmentScore', 'development_score',
  'potentialScore', 'potential_score',
  'improvementScore', 'improvement_score',
  'readinessScore', 'readiness_score',
  'growthScore', 'growth_score',
  'academyScore', 'academy_score',
  'playerProgressRating', 'player_progress_rating',
  'playerRating', 'player_rating',
  'developmentRating', 'developmentRanking', 'coachRanking',
  'progressPercent', 'progress_percent', 'developmentPercent', 'percentDeveloped',
  'ceiling', 'projectedCeiling', 'talentScore',
]);

/** Patterns a client-supplied body may never carry, whatever it is called. */
export const REFUSED_CLIENT_FIELDS = Object.freeze([
  'targetState', 'target_met', 'targetMet', 'progress', 'progressPercent',
  'evidenceConfidence', 'trustScore', 'verified', 'verifiedEvidence',
  'developmentScore', 'potentialScore', 'score', 'rating', 'rank',
]);

// -------------------------------------------------------------- plan vocabulary

/**
 * Who owns a Plan. Exactly two, and ownership is fixed for the life of the
 * record: a player's own plan is never "handed to" a club, and a club's plan
 * is never adopted by the player. A club that wants its own plan creates one;
 * a player who wants a club to see theirs shares it (§8).
 */
export const PLAN_OWNER_KINDS = Object.freeze(['player', 'org']);

/**
 * Visibility is stated at creation and never derived from who created the
 * record (§9). The two look identical for a coach-created plan and mean
 * opposite things:
 *
 *   org_private       the club's own working plan; the player does not see it
 *   shared_with_org   the player's plan, which a named club may read
 */
export const PLAN_VISIBILITY = Object.freeze(['private', 'player_guardian', 'shared_with_org', 'org_private']);

/**
 * Which visibilities each owner kind may choose. Fail closed on anything else.
 *
 * The two axes are different and the vocabulary reflects it: a player's plan
 * can reach outward to named organisations (`shared_with_org`); a club's plan
 * can reach inward to the player (`player_guardian`). A club cannot make its
 * own plan visible to a second club, and a player cannot mark a plan
 * `org_private` — those combinations have no meaning and are refused rather
 * than accepted and then ignored.
 *
 * `private` on a MINOR's plan still means the guardian can see it. A guardian
 * manages a minor's account; a plan the guardian could not read would be a
 * safeguarding gap dressed up as privacy.
 */
export const VISIBILITY_BY_OWNER = Object.freeze({
  player: Object.freeze(['private', 'player_guardian', 'shared_with_org']),
  org: Object.freeze(['org_private', 'player_guardian']),
});

/**
 * Plan status. Deliberately unlike M17's `ROOM_STATUSES`, which does contain
 * `closed`: a Room closes, a plan does not, and §10 asks for the ambiguity to
 * be removed rather than copied.
 */
export const PLAN_STATUSES = Object.freeze(['draft', 'active', 'paused', 'completed', 'archived']);
export const PLAN_TERMINAL = Object.freeze(['archived']);

export const PLAN_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['active', 'archived']),
  active: Object.freeze(['paused', 'completed', 'archived']),
  paused: Object.freeze(['active', 'completed', 'archived']),
  completed: Object.freeze(['active', 'archived']), // reopening a plan is legitimate; erasing it is not
  archived: Object.freeze([]),
});

// -------------------------------------------------------------- goal vocabulary

/**
 * Goal categories (§13).
 *
 * `availability / rehabilitation` is DELIBERATELY ABSENT. §13 permits it
 * "ONLY if repository already supports safely", and the repository does not:
 * there is no medical vocabulary, no consent model for health data and no
 * retention rule for it anywhere in ScoutBox. Adding the category would create
 * a place for a coach to type a diagnosis into a record built for football
 * coaching. The gap is documented rather than filled.
 */
export const GOAL_CATEGORIES = Object.freeze([
  'technical', 'tactical', 'physical', 'psychological',
  'match_understanding', 'position_specific', 'other',
]);

export const GOAL_CATEGORY_LABELS = Object.freeze({
  technical: 'Technical',
  tactical: 'Tactical',
  physical: 'Physical',
  psychological: 'Psychological',
  match_understanding: 'Match understanding',
  position_specific: 'Position-specific',
  other: 'Other',
});

export const GOAL_STATUSES = Object.freeze(['not_started', 'in_progress', 'blocked', 'achieved', 'stopped']);

/**
 * A goal that nobody started cannot have been achieved through this plan —
 * so `not_started → achieved` is refused, and the reviewer moves it through
 * `in_progress` first. `achieved` and `stopped` are reversible on purpose: a
 * reviewer who marked the wrong goal corrects it, and the history keeps both.
 */
export const GOAL_TRANSITIONS = Object.freeze({
  not_started: Object.freeze(['in_progress', 'blocked', 'stopped']),
  in_progress: Object.freeze(['blocked', 'achieved', 'stopped', 'not_started']),
  blocked: Object.freeze(['in_progress', 'stopped', 'not_started']),
  achieved: Object.freeze(['in_progress']),
  stopped: Object.freeze(['in_progress', 'not_started']),
});

/**
 * Structured reasons a goal is blocked (§48).
 *
 * `injury_or_unavailable` is ABSENT for the same reason the availability
 * category is: §48 allows it only "if safe current vocabulary exists", and it
 * does not. A blocked goal can say `other` with the author's own words, which
 * keeps health information out of a structured, filterable field.
 */
export const BLOCK_REASONS = Object.freeze([
  'waiting_for_assessment', 'schedule', 'facility', 'coach_review', 'other',
]);

/**
 * The sentence that travels with every achieved goal, in the payload, so no
 * surface can render the word without it (§16).
 */
export const ACHIEVED_MEANING =
  'Achieved means the plan owner or reviewer marked this agreed objective complete. It is not a ScoutBox finding that the player permanently possesses this ability.';

// ------------------------------------------------------------ action vocabulary

export const ACTION_TYPES = Object.freeze([
  'training', 'assessment', 'video_review', 'match_objective',
  'coach_review', 'combine', 'box_cam', 'evidence_request', 'custom',
]);

export const ACTION_STATUSES = Object.freeze(['todo', 'in_progress', 'done', 'blocked', 'cancelled']);

export const ACTION_TRANSITIONS = Object.freeze({
  todo: Object.freeze(['in_progress', 'done', 'blocked', 'cancelled']),
  in_progress: Object.freeze(['todo', 'done', 'blocked', 'cancelled']),
  blocked: Object.freeze(['todo', 'in_progress', 'cancelled']),
  done: Object.freeze(['in_progress']), // undo a mistaken tick
  cancelled: Object.freeze([]),
});

/** Who an action may be assigned to. Never a person in another organisation. */
export const ASSIGNEE_KINDS = Object.freeze(['player', 'guardian', 'org_user']);

// ---------------------------------------------------------- evidence vocabulary

/**
 * Canonical stores a development link may point at (§23). Every one of these
 * is READ; none is written by M21, and the link record carries no content
 * from any of them — only `{sourceType, sourceId}`.
 */
export const EVIDENCE_SOURCES = Object.freeze([
  'passport_evidence', 'assessment', 'box_cam_session', 'combine_attempt', 'trial_report',
]);

export const EVIDENCE_SOURCE_LABELS = Object.freeze({
  passport_evidence: 'Passport evidence',
  assessment: 'Assessment',
  box_cam_session: 'Box Cam session',
  combine_attempt: 'Combine result',
  trial_report: 'Trial report',
});

/** Why a link cannot be resolved right now. Never carries the hidden detail. */
export const UNAVAILABLE_REASONS = Object.freeze([
  'evidence_not_found', 'evidence_superseded', 'evidence_expired',
  'evidence_withdrawn', 'evidence_not_visible',
]);

// -------------------------------------------------------------- review vocabulary

export const REVIEWER_KINDS = Object.freeze(['player_reflection', 'guardian_reflection', 'coach_review']);

export const REVIEWER_KIND_LABELS = Object.freeze({
  player_reflection: 'Player reflection',
  guardian_reflection: 'Guardian reflection',
  coach_review: 'Coach review',
});

/** What a share action may expose. There is no "share everything" scope. */
export const SHARE_SCOPES = Object.freeze(['summary', 'goals', 'actions']);

// ----------------------------------------------------------------------- limits

/**
 * Bounds, in one table (§106). These bound abuse, not ambition: a plan with
 * twenty goals is already a plan nobody will work through, and the refusal
 * says so rather than truncating silently.
 */
export const M21_LIMITS = Object.freeze({
  activePlansPerOwner: 5,
  goalsPerPlan: 20,
  actionsPerGoal: 20,
  evidenceLinksPerTarget: 30,
  reviewsPageMax: 50,
  historyPageMax: 100,
  listPageMax: 50,
  titleMax: 120,
  descriptionMax: 1000,
  noteMax: 2000,
  summaryMax: 2000,
  blockNoteMax: 300,
});

// ------------------------------------------------------------- the goal library

/**
 * A small, fixed list of common development themes (§67). It is identical for
 * every player and every position, it is offered as text to paste into a title,
 * and it is not a recommendation. Nothing here reads the player, so nothing
 * here can be mistaken for a personalised suggestion.
 */
export const GOAL_LIBRARY = Object.freeze([
  { id: 'first_touch', category: 'technical', title: 'First touch under pressure' },
  { id: 'scanning', category: 'match_understanding', title: 'Scanning before receiving possession' },
  { id: 'weak_foot_passing', category: 'technical', title: 'Weak-foot passing consistency' },
  { id: 'defending_1v1', category: 'tactical', title: '1v1 defending' },
  { id: 'finishing', category: 'technical', title: 'Finishing from inside the box' },
  { id: 'aerial_timing', category: 'physical', title: 'Aerial timing' },
  { id: 'acceleration', category: 'physical', title: 'Acceleration mechanics' },
]);

export const GOAL_LIBRARY_NOTE =
  'Common development themes. The same list is shown to everyone — it is not a recommendation and it does not read this player’s record.';

/**
 * Plan templates (§65/§66): structure only. A template contains headings, not
 * advice, and makes no claim about what suits a position or a player.
 */
export const PLAN_TEMPLATES = Object.freeze([
  {
    id: 'technical_development', title: 'Technical Development',
    goals: Object.freeze([{ category: 'technical' }, { category: 'technical' }]),
  },
  {
    id: 'positional_development', title: 'Positional Development',
    goals: Object.freeze([{ category: 'position_specific' }, { category: 'tactical' }]),
  },
  {
    id: 'trial_follow_up', title: 'Trial Follow-up',
    goals: Object.freeze([{ category: 'match_understanding' }, { category: 'technical' }]),
  },
]);

export const TEMPLATE_NOTE =
  'A template is empty structure: a title and a category for each goal. ScoutBox does not know what a good development plan for this player contains, and does not claim to.';

// ------------------------------------------------------------------ pure helpers

/** UTC calendar day — the M18.2 date semantics, reused, not re-derived (§87). */
export const utcDay = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Whole days between two instants, by UTC calendar day. */
export const daysBetween = (a, b) => Math.round((utcDay(b) - utcDay(a)) / 86_400_000);

/**
 * Due state for a dated thing. Derived at READ time, every time.
 *
 * There is no scheduler in this build (§84/§85). Nothing wakes up at midnight
 * to mark an action overdue, and nothing will send a reminder to a player who
 * does not open the app. This function is the entire mechanism, and the copy
 * that renders it says so rather than implying a background service.
 */
export function dueState(dueAt, now) {
  if (dueAt == null) return { state: 'no_due_date', days: null };
  const days = daysBetween(now, dueAt);
  if (days < 0) return { state: 'overdue', days: Math.abs(days) };
  if (days === 0) return { state: 'due_today', days: 0 };
  if (days <= 7) return { state: 'due_soon', days };
  return { state: 'upcoming', days };
}

/** Review due state from `nextReviewAt` (§86). Same read-time honesty. */
export function reviewDueState(nextReviewAt, now) {
  const d = dueState(nextReviewAt, now);
  if (d.state === 'no_due_date') return { state: 'no_review_scheduled', days: null };
  if (d.state === 'overdue') return { state: 'review_overdue', days: d.days };
  if (d.state === 'due_today' || d.state === 'due_soon') return { state: 'review_due', days: d.days };
  return { state: 'review_upcoming', days: d.days };
}

/** Bounded, trimmed text. Returns null for empty; never truncates silently. */
export function boundedText(raw, max, { field }) {
  if (raw == null || raw === '') return { value: null };
  const s = String(raw).trim();
  if (!s) return { value: null };
  if (s.length > max) {
    return { error: 'TEXT_TOO_LONG', field, max, length: s.length, detail: `${field} may be at most ${max} characters.` };
  }
  return { value: s };
}

/**
 * A date the caller supplied, as an instant. Rejects nonsense rather than
 * repairing it. M23 P5.7 (T-7): a calendar day (`YYYY-MM-DD`, read as the
 * start of that UTC day), an ISO 8601 date-time WITH an offset or Z, or an
 * integer timestamp. A bare local time and an ambiguous `02/03/2026` used to
 * be read in the server's zone and the engine's locale; both are refused now.
 */
export function parseDate(raw, { field }) {
  if (raw == null || raw === '') return { value: null };
  const p = parseDateOrInstant(raw, { dayEdge: 'start' });
  if (!p.ok) return { error: 'DATE_INVALID', field, detail: `${field} is not a date (${p.why}).`, expected: p.expected };
  return { value: p.ms };
}

/** One transition check for all three record kinds. */
export function transitionAllowed(table, from, to) {
  if (from === to) return true;
  return (table[from] ?? []).includes(to);
}

/**
 * Action counts, as counts (§46). The shape deliberately has no ratio field:
 * a client renders "3 of 5 actions completed", and there is no number here
 * that reads as a percentage of a player.
 */
export function actionCounts(actions) {
  const counts = { total: 0, todo: 0, in_progress: 0, done: 0, blocked: 0, cancelled: 0, overdue: 0 };
  for (const a of actions) {
    counts.total += 1;
    counts[a.status] = (counts[a.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * The completion sentence. Cancelled actions leave the denominator, because
 * "3 of 5" where two were called off is a worse answer than "3 of 3".
 */
export function completionPhrase(counts) {
  const total = counts.total - counts.cancelled;
  return { done: counts.done, of: total, phrase: `${counts.done} of ${total} actions completed` };
}

// ------------------------------------------------------------- boot assertion

/**
 * Refuse to boot a development server whose own vocabulary has drifted.
 *
 * This is the M20 pattern (`assertMetricRegistry`) applied to the risk M21
 * actually carries. It checks three things:
 *
 *   1. no label, category, status or template title contains a forbidden name;
 *   2. every status in every vocabulary appears in its transition table, and
 *      every transition target is itself a known status — an unreachable or
 *      undefined state is a bug that surfaces as a mystifying 400 months later;
 *   3. the visibility map only names known visibilities.
 *
 * Development and test throw. Production returns the problems, because a
 * running recruitment platform that refuses to start is its own outage.
 */
/**
 * Scan `[where, text]` pairs for a forbidden product name.
 *
 * A separate exported function rather than a closure inside the assertion,
 * because the vocabulary tables are frozen — which is the right thing for them
 * to be, and which makes "prove the assertion actually bites" impossible to
 * test by mutating them. The scanner is the biting mechanism, so the suite
 * tests it directly with a poisoned pair and separately asserts the real
 * tables pass.
 */
export function scanCopyForForbiddenNames(pairs) {
  const problems = [];
  const forbidden = FORBIDDEN_DEVELOPMENT_NAMES.map((n) => n.toLowerCase());
  for (const [where, text] of pairs) {
    const t = String(text).toLowerCase();
    for (const f of forbidden) if (t.includes(f)) problems.push(`${where}: contains forbidden name "${f}"`);
  }
  return problems;
}

export function assertDevelopmentVocabulary({ mode = process.env.NODE_ENV ?? 'development' } = {}) {
  const problems = scanCopyForForbiddenNames([
    ...Object.entries(GOAL_CATEGORY_LABELS).map(([k, v]) => [`GOAL_CATEGORY_LABELS.${k}`, v]),
    ...Object.entries(EVIDENCE_SOURCE_LABELS).map(([k, v]) => [`EVIDENCE_SOURCE_LABELS.${k}`, v]),
    ...Object.entries(REVIEWER_KIND_LABELS).map(([k, v]) => [`REVIEWER_KIND_LABELS.${k}`, v]),
    ...GOAL_LIBRARY.map((g) => [`GOAL_LIBRARY.${g.id}`, g.title]),
    ...PLAN_TEMPLATES.map((t) => [`PLAN_TEMPLATES.${t.id}`, t.title]),
    ['DEVELOPMENT_PRINCIPLE', DEVELOPMENT_PRINCIPLE],
    ['ACHIEVED_MEANING', ACHIEVED_MEANING],
  ]);

  const checkTable = (name, statuses, table) => {
    for (const s of statuses) {
      if (!Object.prototype.hasOwnProperty.call(table, s)) { problems.push(`${name}: status "${s}" has no transition entry`); continue; }
      for (const to of table[s]) if (!statuses.includes(to)) problems.push(`${name}: "${s}" → "${to}" is not a known status`);
    }
    for (const s of Object.keys(table)) if (!statuses.includes(s)) problems.push(`${name}: transition entry "${s}" is not a status`);
  };
  checkTable('PLAN', PLAN_STATUSES, PLAN_TRANSITIONS);
  checkTable('GOAL', GOAL_STATUSES, GOAL_TRANSITIONS);
  checkTable('ACTION', ACTION_STATUSES, ACTION_TRANSITIONS);

  for (const [owner, vis] of Object.entries(VISIBILITY_BY_OWNER)) {
    if (!PLAN_OWNER_KINDS.includes(owner)) problems.push(`VISIBILITY_BY_OWNER: unknown owner kind "${owner}"`);
    for (const v of vis) if (!PLAN_VISIBILITY.includes(v)) problems.push(`VISIBILITY_BY_OWNER.${owner}: unknown visibility "${v}"`);
  }
  for (const t of PLAN_TEMPLATES) {
    for (const g of t.goals) if (!GOAL_CATEGORIES.includes(g.category)) problems.push(`PLAN_TEMPLATES.${t.id}: unknown category "${g.category}"`);
  }
  for (const g of GOAL_LIBRARY) {
    if (!GOAL_CATEGORIES.includes(g.category)) problems.push(`GOAL_LIBRARY.${g.id}: unknown category "${g.category}"`);
  }

  if (problems.length && mode !== 'production') {
    throw new Error(`M21 development vocabulary invalid:\n  ${problems.join('\n  ')}`);
  }
  return {
    policyVersion: DEVELOPMENT_POLICY_VERSION,
    problems,
    counts: {
      planStatuses: PLAN_STATUSES.length,
      goalStatuses: GOAL_STATUSES.length,
      goalCategories: GOAL_CATEGORIES.length,
      actionTypes: ACTION_TYPES.length,
      actionStatuses: ACTION_STATUSES.length,
      evidenceSources: EVIDENCE_SOURCES.length,
      forbiddenNames: FORBIDDEN_DEVELOPMENT_NAMES.length,
      forbiddenFields: FORBIDDEN_FIELD_NAMES.length,
    },
  };
}

/**
 * Refuse a client body that tries to send something the server derives (§93).
 * Returns the offending keys; the caller answers 400 rather than stripping
 * them, because a client that sent `targetMet` believes it is authoritative
 * and needs to be told it is not.
 */
export function refusedClientFields(body) {
  if (!body || typeof body !== 'object') return [];
  const lower = new Set([...REFUSED_CLIENT_FIELDS, ...FORBIDDEN_FIELD_NAMES].map((k) => k.toLowerCase()));
  return Object.keys(body).filter((k) => lower.has(k.toLowerCase()));
}

/**
 * Walk a response payload and report any key that names something M21 refuses
 * to compute. Used by the acceptance suite against real responses, so "there
 * is no Development Score" is verified on the wire rather than asserted in a
 * document. Arrays and nested objects are walked; values are never inspected.
 */
export function scanPayloadForForbiddenFields(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanPayloadForForbiddenFields(v, `${path}[${i}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const lower = new Set(FORBIDDEN_FIELD_NAMES.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(value)) {
    if (lower.has(k.toLowerCase())) found.push(`${path}.${k}`);
    scanPayloadForForbiddenFields(v, `${path}.${k}`, found);
  }
  return found;
}
