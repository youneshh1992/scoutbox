/**
 * M19 — Dynamic Watchlists: the pure part.
 *
 * A watchlist is saved criteria, not a saved list of players. Membership is
 * DERIVED from the current visible candidates every time it is read, because
 * the alternative — a stored list of player ids treated as truth — goes stale
 * in exactly the ways that matter: a player is blocked, ages out, or their
 * evidence expires, and nobody wrote to the watchlist to say so.
 *
 * Honest limitation, stated here and in the product: this build has no
 * scheduler. Nothing recomputes while the application is closed. Membership is
 * correct as of the last read, and the UI says when that was. What this module
 * provides is the reconciliation that turns "the list I derived last time" and
 * "the list I derive now" into a set of explained transitions.
 */

export const WATCHLIST_MODES = ['live_linked', 'snapshot'];
export const WATCHLIST_STATUSES = ['active', 'paused', 'archived'];
export const WATCHLIST_SOURCES = ['brief', 'saved_search', 'criteria'];

/**
 * Why a player entered or left. Deliberately factual: every one of these names
 * a change in the club's own criteria or in a recorded fact, and none of them
 * says anything about whether the player got better or worse.
 */
export const ENTRY_REASONS = {
  criterion_now_met: 'A required criterion is now met',
  criteria_changed: 'The saved criteria changed',
  brief_changed: 'The linked Recruitment Brief changed',
  newly_visible: 'The player became visible to your organisation',
  first_evaluation: 'First time this watchlist was evaluated',
};
export const EXIT_REASONS = {
  criterion_no_longer_met: 'A required criterion is no longer met',
  criteria_changed: 'The saved criteria changed',
  brief_changed: 'The linked Recruitment Brief changed',
  unavailable: 'This player is no longer available in this watchlist',
};

/**
 * Reasons that must never be spelled out. Losing visibility can mean the
 * player blocked this club, or a safeguarding rule changed, or the account was
 * removed. Naming which one would leak exactly what the rule exists to
 * protect, so all of them surface as `unavailable` (§37–38).
 */
export const PRIVACY_SAFE_EXIT = 'unavailable';

/**
 * Compare the previous derived membership with the current one.
 *
 * `previous` and `current` are arrays of player ids. Returns the three sets
 * plus a stable ordering, so two reconciliations of the same change produce
 * the same output and the same fingerprints.
 */
export function reconcileMembership(previous = [], current = []) {
  const before = new Set(previous);
  const after = new Set(current);
  const entered = current.filter((id) => !before.has(id)).sort();
  const left = previous.filter((id) => !after.has(id)).sort();
  const unchanged = current.filter((id) => before.has(id)).sort();
  return { entered, left, unchanged, changed: entered.length > 0 || left.length > 0 };
}

/**
 * The deterministic identity of one membership transition. Two reconciliations
 * that observe the same transition under the same criteria produce the same
 * fingerprint, so a transition is never notified or recorded twice (§44).
 */
export function transitionFingerprint({ watchlistId, playerId, criteriaVersion, transition, reason }) {
  return `wl:${watchlistId}:${playerId}:${criteriaVersion}:${transition}:${reason}`;
}

/**
 * Which required criterion changed? Given the previous and current per-player
 * match results, name the criterion that actually flipped rather than saying
 * "something changed".
 *
 * Returns `{ reason, criterionId, text }`. When the criteria set itself
 * changed, comparing criterion by criterion would be misleading, so the caller
 * passes `criteriaChanged` and gets the honest answer instead.
 */
export function explainTransition({ previousMatch, currentMatch, criteriaChanged, briefChanged, transition }) {
  if (briefChanged) {
    return { reason: 'brief_changed', criterionId: null, text: transition === 'entered' ? ENTRY_REASONS.brief_changed : EXIT_REASONS.brief_changed };
  }
  if (criteriaChanged) {
    return { reason: 'criteria_changed', criterionId: null, text: transition === 'entered' ? ENTRY_REASONS.criteria_changed : EXIT_REASONS.criteria_changed };
  }
  if (transition === 'entered') {
    if (!previousMatch) {
      return { reason: 'newly_visible', criterionId: null, text: ENTRY_REASONS.newly_visible };
    }
    // Exactly the criteria that went false → true.
    const before = new Map((previousMatch.required ?? []).map((r) => [r.criterionId, r.met]));
    const flipped = (currentMatch.required ?? []).filter((r) => r.met && before.get(r.criterionId) === false);
    if (flipped.length) {
      return {
        reason: 'criterion_now_met',
        criterionId: flipped[0].criterionId,
        text: flipped.map((r) => r.text).join(' · '),
      };
    }
    return { reason: 'criterion_now_met', criterionId: null, text: ENTRY_REASONS.criterion_now_met };
  }
  // Left.
  if (!currentMatch) {
    // No current evaluation at all: the player is not in the visible candidate
    // universe any more. Why is not ours to say.
    return { reason: PRIVACY_SAFE_EXIT, criterionId: null, text: EXIT_REASONS.unavailable };
  }
  const failed = (currentMatch.required ?? []).filter((r) => !r.met);
  if (failed.length) {
    return {
      reason: 'criterion_no_longer_met',
      criterionId: failed[0].criterionId,
      text: failed.map((r) => r.text).join(' · '),
    };
  }
  return { reason: PRIVACY_SAFE_EXIT, criterionId: null, text: EXIT_REASONS.unavailable };
}

/**
 * The one-line summary a watchlist header shows. Counts of the club's own
 * criteria set, never a statement about player quality: "3 newly matched" is
 * three players who now satisfy rules the club wrote, and nothing more.
 */
export function membershipSummary({ entered = [], left = [], unchanged = [] }) {
  return {
    newlyMatched: entered.length,
    noLongerMatches: left.length,
    unchanged: unchanged.length,
    current: entered.length + unchanged.length,
    note: 'Counts of players against criteria your organisation wrote. Entering a watchlist is not an improvement in a player, and leaving one is not a decline.',
  };
}

/**
 * Group membership changes into at most one notification per watchlist (§47).
 * Twenty-five players entering after a brief edit is one sentence, not
 * twenty-five notifications.
 */
export function membershipNotification({ watchlistName, entered = [], left = [], reason }) {
  if (!entered.length && !left.length) return null;
  const bulk = reason === 'criteria_changed' || reason === 'brief_changed';
  const parts = [];
  if (entered.length) parts.push(`${entered.length} ${entered.length === 1 ? 'player now matches' : 'players now match'}`);
  if (left.length) parts.push(`${left.length} no longer ${left.length === 1 ? 'matches' : 'match'}`);
  const tail = bulk
    ? (reason === 'brief_changed' ? ' after the linked Recruitment Brief changed' : ' after the criteria changed')
    : '';
  return {
    text: `${parts.join(', ')} “${watchlistName}”${tail}.`,
    grouped: true,
    entered: entered.length,
    left: left.length,
  };
}

/** A watchlist that cannot currently produce matches, and why. Never a zero
 *  presented as a factual "no players match" (§107). */
export function watchlistBlockedState({ status, mode, brief }) {
  if (status === 'archived') return { blocked: true, code: 'WATCHLIST_ARCHIVED', message: 'This watchlist is archived. Its history is kept; membership is no longer maintained.' };
  if (status === 'paused') return { blocked: false, paused: true, code: 'WATCHLIST_PAUSED', message: 'This watchlist is paused. Membership is still shown, and no change notifications are sent.' };
  if (mode === 'live_linked') {
    if (!brief) return { blocked: true, code: 'WATCHLIST_BRIEF_UNAVAILABLE', message: 'The linked Recruitment Brief is no longer available. Membership cannot be maintained until the link is changed.' };
    if (brief.status !== 'active') return { blocked: true, code: 'WATCHLIST_BRIEF_INACTIVE', message: `The linked Recruitment Brief is ${brief.status}. Activate it, or switch this watchlist to its own saved criteria.` };
  }
  return { blocked: false };
}
