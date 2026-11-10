/**
 * Development Hub vocabulary, limits and pure rules. ScoutBox documents and
 * coordinates development; it does not rate a player, and
 * `assertDevelopmentVocabulary()` refuses to boot if the vocabulary drifts
 * towards a rating.
 */

import { parseDateOrInstant } from '../../../temporal.mjs';

export const DEVELOPMENT_POLICY_VERSION = 1;

/** Sent on the wire so clients render the server's sentence, not a paraphrase. */
export const DEVELOPMENT_PRINCIPLE =
  'Document and coordinate development. ScoutBox does not measure a player’s worth, ceiling or future.';

// ---------------------------------------------------------------- never built

/**
 * Names the hub refuses: a single blended figure invites a decision about a
 * person that the figure cannot support. Scanned against exported labels at boot.
 */
export const FORBIDDEN_DEVELOPMENT_NAMES = Object.freeze([
  'Development Score',
  'Potential Score',
  'Improvement Score',
  'Readiness Score',
  'Growth Score',
  'Academy Score',
  'Player Progress Rating',
  'Player Rating',
  'Development Rating',
  'Development Ranking',
  'Coach Ranking',
]);

/**
 * The same refusal as payload keys. Kept apart from the names because copy may
 * say a word while denying it ("does not measure a player's ceiling").
 */
export const FORBIDDEN_FIELD_NAMES = Object.freeze([
  'developmentScore',
  'development_score',
  'potentialScore',
  'potential_score',
  'improvementScore',
  'improvement_score',
  'readinessScore',
  'readiness_score',
  'growthScore',
  'growth_score',
  'academyScore',
  'academy_score',
  'playerProgressRating',
  'player_progress_rating',
  'playerRating',
  'player_rating',
  'developmentRating',
  'developmentRanking',
  'coachRanking',
  'progressPercent',
  'progress_percent',
  'developmentPercent',
  'percentDeveloped',
  'ceiling',
  'projectedCeiling',
  'talentScore',
]);

/** Patterns a client-supplied body may never carry, whatever it is called. */
export const REFUSED_CLIENT_FIELDS = Object.freeze([
  'targetState',
  'target_met',
  'targetMet',
  'progress',
  'progressPercent',
  'evidenceConfidence',
  'trustScore',
  'verified',
  'verifiedEvidence',
  'developmentScore',
  'potentialScore',
  'score',
  'rating',
  'rank',
]);

// -------------------------------------------------------------- plan vocabulary

/** Ownership is fixed for the life of a plan; it is never transferred. */
export const PLAN_OWNER_KINDS = Object.freeze(['player', 'org']);

/**
 * Stated at creation, never derived from who created the record.
 *   org_private       the club's own working plan; the player does not see it
 *   shared_with_org   the player's plan, which a named club may read
 */
export const PLAN_VISIBILITY = Object.freeze(['private', 'player_guardian', 'shared_with_org', 'org_private']);

/**
 * A player's plan reaches outward to named clubs; a club's plan reaches inward
 * to the player. `private` on a minor's plan still lets the guardian read it:
 * hiding it from them would be a safeguarding gap.
 */
export const VISIBILITY_BY_OWNER = Object.freeze({
  player: Object.freeze(['private', 'player_guardian', 'shared_with_org']),
  org: Object.freeze(['org_private', 'player_guardian']),
});

/** Unlike `ROOM_STATUSES` there is no `closed`: a Room closes, a plan does not. */
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
 * No availability/rehabilitation category: ScoutBox has no consent or retention
 * model for health data, so there must be no place to type a diagnosis.
 */
export const GOAL_CATEGORIES = Object.freeze([
  'technical',
  'tactical',
  'physical',
  'psychological',
  'match_understanding',
  'position_specific',
  'other',
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
 * `not_started → achieved` is refused: a goal nobody started was not achieved
 * through this plan. `achieved` and `stopped` are reversible so a reviewer can
 * correct a mistake; the history keeps both.
 */
export const GOAL_TRANSITIONS = Object.freeze({
  not_started: Object.freeze(['in_progress', 'blocked', 'stopped']),
  in_progress: Object.freeze(['blocked', 'achieved', 'stopped', 'not_started']),
  blocked: Object.freeze(['in_progress', 'stopped', 'not_started']),
  achieved: Object.freeze(['in_progress']),
  stopped: Object.freeze(['in_progress', 'not_started']),
});

/** No injury reason, for the same health-data reason as the categories. */
export const BLOCK_REASONS = Object.freeze(['waiting_for_assessment', 'schedule', 'facility', 'coach_review', 'other']);

/** Sent with every achieved goal so no surface renders the word without it. */
export const ACHIEVED_MEANING =
  'Achieved means the plan owner or reviewer marked this agreed objective complete. It is not a ScoutBox finding that the player permanently possesses this ability.';

// ------------------------------------------------------------ action vocabulary

export const ACTION_TYPES = Object.freeze([
  'training',
  'assessment',
  'video_review',
  'match_objective',
  'coach_review',
  'combine',
  'box_cam',
  'evidence_request',
  'custom',
]);

export const ACTION_STATUSES = Object.freeze(['todo', 'in_progress', 'done', 'blocked', 'cancelled']);

export const ACTION_TRANSITIONS = Object.freeze({
  todo: Object.freeze(['in_progress', 'done', 'blocked', 'cancelled']),
  in_progress: Object.freeze(['todo', 'done', 'blocked', 'cancelled']),
  blocked: Object.freeze(['todo', 'in_progress', 'cancelled']),
  done: Object.freeze(['in_progress']), // undo a mistaken tick
  cancelled: Object.freeze([]),
});

/** An `org_user` assignee must belong to the plan's organisation. */
export const ASSIGNEE_KINDS = Object.freeze(['player', 'guardian', 'org_user']);

// ---------------------------------------------------------- evidence vocabulary

/** A link stores only `{sourceType, sourceId}`, never content from the source. */
export const EVIDENCE_SOURCES = Object.freeze([
  'passport_evidence',
  'assessment',
  'box_cam_session',
  'combine_attempt',
  'trial_report',
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
  'evidence_not_found',
  'evidence_superseded',
  'evidence_expired',
  'evidence_withdrawn',
  'evidence_not_visible',
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

/** These bound abuse; over a limit is refused, never truncated. */
export const DEVELOPMENT_HUB_LIMITS = Object.freeze({
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

/** The same for every player, so it cannot read as a personalised suggestion. */
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

/** Structure only: headings, not advice. */
export const PLAN_TEMPLATES = Object.freeze([
  {
    id: 'technical_development',
    title: 'Technical Development',
    goals: Object.freeze([{ category: 'technical' }, { category: 'technical' }]),
  },
  {
    id: 'positional_development',
    title: 'Positional Development',
    goals: Object.freeze([{ category: 'position_specific' }, { category: 'tactical' }]),
  },
  {
    id: 'trial_follow_up',
    title: 'Trial Follow-up',
    goals: Object.freeze([{ category: 'match_understanding' }, { category: 'technical' }]),
  },
]);

export const TEMPLATE_NOTE =
  'A template is empty structure: a title and a category for each goal. ScoutBox does not know what a good development plan for this player contains, and does not claim to.';

// ------------------------------------------------------------------ pure helpers

export const utcDay = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Whole days between two instants, by UTC calendar day. */
export const daysBetween = (a, b) => Math.round((utcDay(b) - utcDay(a)) / 86_400_000);

/**
 * Derived at read time. There is no scheduler and no reminders; the copy that
 * renders this must not imply a background service.
 */
export function dueState(dueAt, now) {
  if (dueAt == null) return { state: 'no_due_date', days: null };
  const days = daysBetween(now, dueAt);
  if (days < 0) return { state: 'overdue', days: Math.abs(days) };
  if (days === 0) return { state: 'due_today', days: 0 };
  if (days <= 7) return { state: 'due_soon', days };
  return { state: 'upcoming', days };
}

export function reviewDueState(nextReviewAt, now) {
  const d = dueState(nextReviewAt, now);
  if (d.state === 'no_due_date') return { state: 'no_review_scheduled', days: null };
  if (d.state === 'overdue') return { state: 'review_overdue', days: d.days };
  if (d.state === 'due_today' || d.state === 'due_soon') return { state: 'review_due', days: d.days };
  return { state: 'review_upcoming', days: d.days };
}

/** Trimmed text; null for empty; over-long text is refused, not truncated. */
export function boundedText(raw, max, { field }) {
  if (raw == null || raw === '') return { value: null };
  if (typeof raw !== 'string') return { error: 'FIELD_INVALID', field, detail: `${field} is text.` };
  const s = raw.trim();
  if (!s) return { value: null };
  if (s.length > max) {
    return {
      error: 'TEXT_TOO_LONG',
      field,
      max,
      length: s.length,
      detail: `${field} may be at most ${max} characters.`,
    };
  }
  return { value: s };
}

/**
 * Accepts `YYYY-MM-DD` (start of that UTC day), ISO 8601 with an offset or Z,
 * or an integer timestamp. Bare local times and `02/03/2026` are refused: they
 * would be read in the server's zone and locale.
 */
export function parseDate(raw, { field }) {
  if (raw == null || raw === '') return { value: null };
  const p = parseDateOrInstant(raw, { dayEdge: 'start' });
  if (!p.ok)
    return { error: 'DATE_INVALID', field, detail: `${field} is not a date (${p.why}).`, expected: p.expected };
  // An instant is stored as an integer column; one beyond the safe range is refused, not stored.
  if (!Number.isSafeInteger(p.ms))
    return { error: 'DATE_INVALID', field, detail: `${field} is not a date (out of range).` };
  return { value: p.ms };
}

export function transitionAllowed(table, from, to) {
  if (from === to) return true;
  return (table[from] ?? []).includes(to);
}

/** Counts only, no ratio: nothing here should read as a percentage of a player. */
export function actionCounts(actions) {
  const counts = { total: 0, todo: 0, in_progress: 0, done: 0, blocked: 0, cancelled: 0, overdue: 0 };
  for (const a of actions) {
    counts.total += 1;
    counts[a.status] = (counts[a.status] ?? 0) + 1;
  }
  return counts;
}

/** Cancelled actions leave the denominator. */
export function completionPhrase(counts) {
  const total = counts.total - counts.cancelled;
  return { done: counts.done, of: total, phrase: `${counts.done} of ${total} actions completed` };
}

// ------------------------------------------------------------- boot assertion

/** Exported so tests can feed it a poisoned pair: the real tables are frozen. */
export function scanCopyForForbiddenNames(pairs) {
  const problems = [];
  const forbidden = FORBIDDEN_DEVELOPMENT_NAMES.map((n) => n.toLowerCase());
  for (const [where, text] of pairs) {
    const t = String(text).toLowerCase();
    for (const f of forbidden) if (t.includes(f)) problems.push(`${where}: contains forbidden name "${f}"`);
  }
  return problems;
}

/**
 * Checks for forbidden names in copy, transition tables that name unknown
 * statuses, and unknown visibilities. Throws outside production; production
 * returns the problems because refusing to start is its own outage.
 */
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
      if (!Object.prototype.hasOwnProperty.call(table, s)) {
        problems.push(`${name}: status "${s}" has no transition entry`);
        continue;
      }
      for (const to of table[s])
        if (!statuses.includes(to)) problems.push(`${name}: "${s}" → "${to}" is not a known status`);
    }
    for (const s of Object.keys(table))
      if (!statuses.includes(s)) problems.push(`${name}: transition entry "${s}" is not a status`);
  };
  checkTable('PLAN', PLAN_STATUSES, PLAN_TRANSITIONS);
  checkTable('GOAL', GOAL_STATUSES, GOAL_TRANSITIONS);
  checkTable('ACTION', ACTION_STATUSES, ACTION_TRANSITIONS);

  for (const [owner, vis] of Object.entries(VISIBILITY_BY_OWNER)) {
    if (!PLAN_OWNER_KINDS.includes(owner)) problems.push(`VISIBILITY_BY_OWNER: unknown owner kind "${owner}"`);
    for (const v of vis)
      if (!PLAN_VISIBILITY.includes(v)) problems.push(`VISIBILITY_BY_OWNER.${owner}: unknown visibility "${v}"`);
  }
  for (const t of PLAN_TEMPLATES) {
    for (const g of t.goals)
      if (!GOAL_CATEGORIES.includes(g.category))
        problems.push(`PLAN_TEMPLATES.${t.id}: unknown category "${g.category}"`);
  }
  for (const g of GOAL_LIBRARY) {
    if (!GOAL_CATEGORIES.includes(g.category)) problems.push(`GOAL_LIBRARY.${g.id}: unknown category "${g.category}"`);
  }

  if (problems.length && mode !== 'production') {
    throw new Error(`Development Hub vocabulary invalid:\n  ${problems.join('\n  ')}`);
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
 * Keys a client may not send because the server derives them. The caller
 * answers 400 rather than stripping them, so the client learns it is not
 * authoritative.
 */
export function refusedClientFields(body) {
  if (!body || typeof body !== 'object') return [];
  const lower = new Set([...REFUSED_CLIENT_FIELDS, ...FORBIDDEN_FIELD_NAMES].map((k) => k.toLowerCase()));
  return Object.keys(body).filter((k) => lower.has(k.toLowerCase()));
}

/** Used by tests on real responses. Walks keys only, never values. */
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
