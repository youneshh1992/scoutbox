/**
 * Dynamic Watchlists: the pure part. A watchlist is saved criteria; membership is derived on every read, because a
 * stored list goes stale when a player is blocked, ages out or their evidence expires. There is no scheduler, so
 * membership is correct as of the last read, and the UI says when that was.
 */

export const WATCHLIST_MODES = ['live_linked', 'snapshot'];
export const WATCHLIST_STATUSES = ['active', 'paused', 'archived'];
export const WATCHLIST_SOURCES = ['brief', 'saved_search', 'criteria'];

/** None of these says whether the player got better or worse. */
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
 * Losing visibility can mean the player blocked this club, a safeguarding rule changed, or the account was removed.
 * Naming which would leak what the rule protects, so all of them surface as `unavailable`.
 */
export const PRIVACY_SAFE_EXIT = 'unavailable';

/** Sorted, so two reconciliations of the same change produce the same output and fingerprints. */
export function reconcileMembership(previous = [], current = []) {
  const before = new Set(previous);
  const after = new Set(current);
  const entered = current.filter((id) => !before.has(id)).sort();
  const left = previous.filter((id) => !after.has(id)).sort();
  const unchanged = current.filter((id) => before.has(id)).sort();
  return { entered, left, unchanged, changed: entered.length > 0 || left.length > 0 };
}

/** The same transition under the same criteria has the same fingerprint, so it is not notified twice. */
export function transitionFingerprint({ watchlistId, playerId, criteriaVersion, transition, reason }) {
  return `wl:${watchlistId}:${playerId}:${criteriaVersion}:${transition}:${reason}`;
}

/**
 * Names the criterion that flipped. When the criteria set itself changed, comparing criterion by criterion would
 * mislead, so `criteriaChanged` short-circuits it.
 */
export function explainTransition({ previousMatch, currentMatch, criteriaChanged, briefChanged, transition }) {
  if (briefChanged) {
    return {
      reason: 'brief_changed',
      criterionId: null,
      text: transition === 'entered' ? ENTRY_REASONS.brief_changed : EXIT_REASONS.brief_changed,
    };
  }
  if (criteriaChanged) {
    return {
      reason: 'criteria_changed',
      criterionId: null,
      text: transition === 'entered' ? ENTRY_REASONS.criteria_changed : EXIT_REASONS.criteria_changed,
    };
  }
  if (transition === 'entered') {
    if (!previousMatch) {
      return { reason: 'newly_visible', criterionId: null, text: ENTRY_REASONS.newly_visible };
    }
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
  if (!currentMatch) {
    // No longer visible; why is not ours to say.
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

export function membershipSummary({ entered = [], left = [], unchanged = [] }) {
  return {
    newlyMatched: entered.length,
    noLongerMatches: left.length,
    unchanged: unchanged.length,
    current: entered.length + unchanged.length,
    note: 'Counts of players against criteria your organisation wrote. Entering a watchlist is not an improvement in a player, and leaving one is not a decline.',
  };
}

/** At most one notification per watchlist: 25 players entering after a brief edit is one sentence. */
export function membershipNotification({ watchlistName, entered = [], left = [], reason }) {
  if (!entered.length && !left.length) return null;
  const bulk = reason === 'criteria_changed' || reason === 'brief_changed';
  const parts = [];
  if (entered.length)
    parts.push(`${entered.length} ${entered.length === 1 ? 'player now matches' : 'players now match'}`);
  if (left.length) parts.push(`${left.length} no longer ${left.length === 1 ? 'matches' : 'match'}`);
  const tail = bulk
    ? reason === 'brief_changed'
      ? ' after the linked Recruitment Brief changed'
      : ' after the criteria changed'
    : '';
  return {
    text: `${parts.join(', ')} “${watchlistName}”${tail}.`,
    grouped: true,
    entered: entered.length,
    left: left.length,
  };
}

/** A watchlist that cannot produce matches says why, rather than showing zero as "no players match". */
export function watchlistBlockedState({ status, mode, brief }) {
  if (status === 'archived')
    return {
      blocked: true,
      code: 'WATCHLIST_ARCHIVED',
      message: 'This watchlist is archived. Its history is kept; membership is no longer maintained.',
    };
  if (status === 'paused')
    return {
      blocked: false,
      paused: true,
      code: 'WATCHLIST_PAUSED',
      message: 'This watchlist is paused. Membership is still shown, and no change notifications are sent.',
    };
  if (mode === 'live_linked') {
    if (!brief)
      return {
        blocked: true,
        code: 'WATCHLIST_BRIEF_UNAVAILABLE',
        message:
          'The linked Recruitment Brief is no longer available. Membership cannot be maintained until the link is changed.',
      };
    if (brief.status !== 'active')
      return {
        blocked: true,
        code: 'WATCHLIST_BRIEF_INACTIVE',
        message: `The linked Recruitment Brief is ${brief.status}. Activate it, or switch this watchlist to its own saved criteria.`,
      };
  }
  return { blocked: false };
}
