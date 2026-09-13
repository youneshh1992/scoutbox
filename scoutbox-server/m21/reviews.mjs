/**
 * M21 — Development Reviews: append-only, and corrected by supersession.
 *
 * A review is a statement about what was true at a moment. That is the whole
 * value of it: six months later, "we agreed in August that these two goals
 * were in progress" is only useful if nobody has since edited August. So there
 * is no PATCH route for a submitted review anywhere in this milestone, and
 * this module offers no function that mutates one (§34).
 *
 * Corrections are real and necessary — a reviewer picks the wrong plan, or
 * writes the wrong date — and they work by appending a new review that names
 * the one it replaces. Both stay readable. The superseded review is marked,
 * not hidden: a record that quietly vanishes when corrected is a record nobody
 * can rely on.
 *
 * The snapshot (§35) records enough goal state to explain what the reviewer
 * was looking at, and deliberately not the Passport. A review is a note about
 * a plan; a copy of the player's canonical evidence inside it would be a second
 * Passport with a date stamp, frozen and slowly becoming wrong.
 */
import {
  M21_LIMITS, REVIEWER_KINDS, SHARE_SCOPES, boundedText, parseDate,
  actionCounts, completionPhrase,
} from './shared.mjs';
import { evaluateTarget } from './targets.mjs';

/**
 * Build the goal snapshots for a review (§35).
 *
 * Per goal: its status, how many actions stood where, which evidence was
 * cited (ids only — the content is resolved live when the review is read, so
 * a snapshot cannot preserve a claim the evidence has since withdrawn), and
 * the target state if the goal had a target.
 */
export function buildGoalSnapshots({ goals, actions, links, attempts, sessions }) {
  const actionsByGoal = new Map();
  for (const a of actions) {
    if (!actionsByGoal.has(a.goalId)) actionsByGoal.set(a.goalId, []);
    actionsByGoal.get(a.goalId).push(a);
  }
  const linksByGoal = new Map();
  for (const l of links) {
    if (!l.goalId) continue;
    if (!linksByGoal.has(l.goalId)) linksByGoal.set(l.goalId, []);
    linksByGoal.get(l.goalId).push(l);
  }

  return goals
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)))
    .map((g) => {
      const counts = actionCounts(actionsByGoal.get(g.id) ?? []);
      const target = g.target ? evaluateTarget({ target: g.target, attempts, sessions }) : null;
      return {
        goalId: g.id,
        title: g.title,
        category: g.category,
        status: g.status,
        actionCounts: { total: counts.total, done: counts.done, blocked: counts.blocked, cancelled: counts.cancelled },
        completion: completionPhrase(counts),
        // References, not evidence. The same rule as everywhere else in M21.
        evidenceRefs: (linksByGoal.get(g.id) ?? []).map((l) => ({ sourceType: l.sourceType, sourceId: l.sourceId })),
        // What the measurement said at review time — and, because it is
        // re-evaluated on read for the CURRENT state elsewhere, this is
        // explicitly labelled as the state then.
        targetStateAtReview: target ? { state: target.state, reason: target.reason, measured: target.measured?.value ?? null } : null,
      };
    });
}

/**
 * Validate a review submission.
 *
 * `reviewerKind` is not the caller's to choose freely: it follows from who
 * they are. A club cannot file a "Player reflection", and a player cannot file
 * a "Coach review" — the label is the provenance, and a provenance the subject
 * can set is not provenance (§37/§38).
 */
export function validateReview({ body, access, viewer, now }) {
  const kind = viewer.kind === 'player_self' ? 'player_reflection'
    : viewer.kind === 'guardian' ? 'guardian_reflection'
      : 'coach_review';
  if (!REVIEWER_KINDS.includes(kind)) return { error: 'REVIEWER_KIND_UNKNOWN' };

  if (kind === 'coach_review' && !access.review) {
    return { error: 'REVIEW_NOT_PERMITTED', detail: 'Only staff of the organisation that owns this plan can submit a coach review.' };
  }
  if (kind !== 'coach_review' && !access.reflect) {
    return { error: 'REVIEW_NOT_PERMITTED', detail: 'You cannot add a reflection to this plan.' };
  }

  const summary = boundedText(body?.summary, M21_LIMITS.summaryMax, { field: 'summary' });
  if (summary.error) return summary;

  // An internal note is a club talking to itself. A player or guardian has no
  // "internal" — they have their own words, which are the summary — so an
  // attempt to send one is refused rather than silently dropped.
  let internalNote = null;
  if (body?.internalNote != null && body.internalNote !== '') {
    if (!access.readInternal) {
      return { error: 'INTERNAL_NOTE_NOT_PERMITTED', detail: 'Only the organisation that owns this plan can record an internal note.' };
    }
    const n = boundedText(body.internalNote, M21_LIMITS.noteMax, { field: 'internalNote' });
    if (n.error) return n;
    internalNote = n.value;
  }

  if (!summary.value && !internalNote) {
    return { error: 'REVIEW_EMPTY', detail: 'A review needs a summary, an internal note, or both.' };
  }

  const next = parseDate(body?.nextReviewAt, { field: 'nextReviewAt' });
  if (next.error) return next;
  if (next.value != null && next.value < now) {
    return { error: 'DATE_IN_PAST', field: 'nextReviewAt', detail: 'The next review date cannot be in the past.' };
  }

  let shareScopes = [];
  if (body?.shareWithPlayer) {
    if (!access.readInternal) {
      // A player's own reflection is theirs; there is nothing to "share".
      return { error: 'SHARE_NOT_APPLICABLE', detail: 'Only a club review can be shared with the player.' };
    }
    if (!summary.value) {
      return { error: 'SHARE_NEEDS_SUMMARY', detail: 'A review shared with the player needs a summary. The internal note is never shared.' };
    }
    const asked = Array.isArray(body.shareScopes) && body.shareScopes.length ? body.shareScopes.map(String) : ['summary'];
    const unknown = asked.filter((s) => !SHARE_SCOPES.includes(s));
    if (unknown.length) return { error: 'SHARE_SCOPE_UNKNOWN', allowed: SHARE_SCOPES, detail: `Unknown share scope: ${unknown.join(', ')}.` };
    shareScopes = [...new Set(asked)];
  }

  return {
    value: {
      reviewerKind: kind,
      sharedSummary: summary.value,
      internalNote,
      nextReviewAt: next.value,
      shareScopes,
      shareWithPlayer: shareScopes.length > 0,
    },
  };
}

/**
 * Validate a correction. The review being corrected must belong to the same
 * plan, must not already have been superseded, and must have been written by
 * the same side of the wall: a club corrects its own review, a player their
 * own reflection. Nobody corrects somebody else's record.
 */
export function validateSupersession({ target, plan, reviews, viewer, access }) {
  if (!target) return { error: 'REVIEW_NOT_FOUND' };
  if (target.planId !== plan.id) return { error: 'REVIEW_NOT_FOUND' };
  if (target.supersededBy) {
    const chain = reviews.find((r) => r.id === target.supersededBy);
    return { error: 'REVIEW_ALREADY_SUPERSEDED', supersededBy: chain?.id ?? target.supersededBy, detail: 'That review has already been corrected. Correct the current version instead.' };
  }
  const clubSide = access.readInternal;
  const targetIsClub = target.reviewerKind === 'coach_review';
  if (clubSide !== targetIsClub) {
    return { error: 'REVIEW_NOT_CORRECTABLE', detail: 'A club review is corrected by the club, and a reflection by the person who wrote it.' };
  }
  if (!clubSide && target.reviewedBy?.id !== (viewer.playerId ?? viewer.guardianId)) {
    return { error: 'REVIEW_NOT_CORRECTABLE', detail: 'You can only correct a reflection you wrote.' };
  }
  return { value: target };
}

/** Bounded, newest-first page of reviews. Stable across reads. */
export function pageReviews(reviews, { limit, cursor }) {
  const all = reviews.slice().sort((a, b) => b.reviewedAt - a.reviewedAt || String(b.id).localeCompare(String(a.id)));
  const size = Math.min(Math.max(Number(limit) || 25, 1), M21_LIMITS.reviewsPageMax);
  let start = 0;
  if (cursor) {
    const idx = all.findIndex((r) => r.id === String(cursor));
    if (idx < 0) return { error: 'REVIEW_CURSOR_INVALID', detail: 'That page no longer exists — start again from the first page.' };
    start = idx + 1;
  }
  const page = all.slice(start, start + size);
  return {
    value: {
      items: page,
      total: all.length,
      nextCursor: start + size < all.length ? page[page.length - 1]?.id ?? null : null,
    },
  };
}
