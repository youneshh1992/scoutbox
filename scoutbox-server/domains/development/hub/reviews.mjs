/**
 * Development Reviews record what was true at a moment, so they are
 * append-only: a correction is a new review naming the one it replaces, and
 * both stay readable. Snapshots hold goal state and evidence ids, never a
 * copy of the Passport.
 */
import {
  DEVELOPMENT_HUB_LIMITS, REVIEWER_KINDS, SHARE_SCOPES, boundedText, parseDate,
  actionCounts, completionPhrase,
} from './shared.mjs';
import { evaluateTarget } from './targets.mjs';

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
        evidenceRefs: (linksByGoal.get(g.id) ?? []).map((l) => ({ sourceType: l.sourceType, sourceId: l.sourceId })),
        // The state then; the current state is re-evaluated on read elsewhere.
        targetStateAtReview: target ? { state: target.state, reason: target.reason, measured: target.measured?.value ?? null } : null,
      };
    });
}

/** `reviewerKind` is provenance, so it follows from the viewer, not the body. */
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

  const summary = boundedText(body?.summary, DEVELOPMENT_HUB_LIMITS.summaryMax, { field: 'summary' });
  if (summary.error) return summary;

  let internalNote = null;
  if (body?.internalNote != null && body.internalNote !== '') {
    if (!access.readInternal) {
      return { error: 'INTERNAL_NOTE_NOT_PERMITTED', detail: 'Only the organisation that owns this plan can record an internal note.' };
    }
    const n = boundedText(body.internalNote, DEVELOPMENT_HUB_LIMITS.noteMax, { field: 'internalNote' });
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

/** A club corrects its own review, a player or guardian their own reflection. */
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

export function pageReviews(reviews, { limit, cursor }) {
  const all = reviews.slice().sort((a, b) => b.reviewedAt - a.reviewedAt || String(b.id).localeCompare(String(a.id)));
  const size = Math.min(Math.max(Number(limit) || 25, 1), DEVELOPMENT_HUB_LIMITS.reviewsPageMax);
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
