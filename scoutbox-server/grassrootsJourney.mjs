// The Grassroots player journey: the academy experience, without the academy.
// Everything here is EXCLUSIVE to amateur/semi-pro players — structure
// (training programmes), recognition (badges, level-up moments), honest
// context (cohort percentiles — never leaderboards), and a visible ladder
// (the pathway). Pro-level players never see any of it.

// --------------------------------------------------------------- programmes
// Free structured training built from the verified combine drills. Academy
// players get coaches; grassroots players get this.
export const PROGRAMME_TRACKS = {
  attack: {
    key: 'attack',
    label: 'Attacking track',
    positions: ['ST', 'CF', 'RW', 'LW', 'CAM'],
    sessions: [
      { id: 'atk-sprint', day: 'Mon', title: 'Sprint ladder — top-end pace', drillId: 'drill-sprint-ladder' },
      { id: 'atk-finish', day: 'Wed', title: 'Shooting arc — 20 finishes', drillId: 'drill-shooting-arc' },
      { id: 'atk-touch', day: 'Fri', title: 'First touch under fatigue', drillId: 'drill-first-touch' },
      { id: 'atk-match', day: 'Sat', title: 'Match or small-sided game (log attendance)', drillId: null },
    ],
  },
  midfield: {
    key: 'midfield',
    label: 'Midfield track',
    positions: ['CM', 'CDM', 'RB', 'LB', 'RWB', 'LWB'],
    sessions: [
      { id: 'mid-pass', day: 'Mon', title: 'Passing gates — both feet', drillId: 'drill-passing-gates' },
      { id: 'mid-touch', day: 'Wed', title: 'First touch — wall rebounds', drillId: 'drill-first-touch' },
      { id: 'mid-sprint', day: 'Fri', title: 'Repeat sprints — recovery runs', drillId: 'drill-sprint-ladder' },
      { id: 'mid-match', day: 'Sat', title: 'Match or small-sided game (log attendance)', drillId: null },
    ],
  },
  defence: {
    key: 'defence',
    label: 'Defensive track',
    positions: ['CB'],
    sessions: [
      { id: 'def-sprint', day: 'Mon', title: 'Recovery sprints', drillId: 'drill-sprint-ladder' },
      { id: 'def-pass', day: 'Wed', title: 'Passing gates — building out', drillId: 'drill-passing-gates' },
      { id: 'def-touch', day: 'Fri', title: 'First touch under pressure', drillId: 'drill-first-touch' },
      { id: 'def-match', day: 'Sat', title: 'Match or small-sided game (log attendance)', drillId: null },
    ],
  },
  keeper: {
    key: 'keeper',
    label: 'Goalkeeper track',
    positions: ['GK'],
    sessions: [
      { id: 'gk-feet', day: 'Mon', title: 'Distribution — passing gates', drillId: 'drill-passing-gates' },
      { id: 'gk-hands', day: 'Wed', title: 'Handling — wall rebounds', drillId: 'drill-first-touch' },
      { id: 'gk-power', day: 'Fri', title: 'Explosive steps — sprint ladder', drillId: 'drill-sprint-ladder' },
      { id: 'gk-match', day: 'Sat', title: 'Match or shot-stopping session (log attendance)', drillId: null },
    ],
  },
};

export function trackForPosition(position) {
  for (const track of Object.values(PROGRAMME_TRACKS)) {
    if (track.positions.includes(position)) return track.key;
  }
  return 'midfield';
}

const WEEK = 7 * 24 * 3600 * 1000;
/** Monday-anchored week bucket, so "this week's sessions" resets weekly. */
export function weekKey(ts = Date.now()) {
  return Math.floor((ts - 4 * 24 * 3600 * 1000) / WEEK); // epoch was a Thursday
}

export function programmeProgress(player, now = Date.now()) {
  if (!player.programme) return null;
  const track = PROGRAMME_TRACKS[player.programme.track];
  if (!track) return null;
  const thisWeek = weekKey(now);
  const done = (player.programme.completed ?? []).filter((c) => weekKey(c.ts) === thisWeek).map((c) => c.sessionId);
  return {
    track: track.key,
    label: track.label,
    startedAt: player.programme.startedAt,
    sessions: track.sessions.map((s) => ({ ...s, done: done.includes(s.id) })),
    doneThisWeek: done.length,
    totalPerWeek: track.sessions.length,
  };
}

// ------------------------------------------------------------------ pathway
// The visible ladder. Levels move on real signings (playerLevelAfterSigning);
// this just makes the climb legible to the player.
export function pathwayFor(player, { vouchCount = 0 } = {}) {
  if (player.level === 'pro') return null; // the journey view belongs to grassroots
  const level = player.level ?? 'amateur';
  const verifiedClips = (player.media ?? []).filter((m) => m.verifiedClip).length;
  const combineVerified = (player.drillResults ?? []).filter((r) => r.verified).length;
  return {
    level,
    steps: [
      { key: 'amateur', label: 'Amateur', reached: true, note: 'Where every journey starts.' },
      { key: 'semi_pro', label: 'Semi-pro', reached: level === 'semi_pro', note: 'A grassroots club signing takes you here.' },
      { key: 'pro', label: 'Academy / Pro', reached: false, note: 'An academy or pro club signing takes you here — and onto ScoutBox.' },
    ],
    // What clubs actually look at — the player's controllable signals.
    signals: {
      verifiedAttendances: (player.attendance ?? []).length,
      verifiedClips,
      combineVerified,
      coachVouches: vouchCount,
    },
    nextStep: level === 'amateur'
      ? 'Get seen locally: verified attendance, a verified clip, and a coach vouch are what nearby clubs check first.'
      : 'Keep the record growing — academy scouts on ScoutBox see your trust, combine numbers and trial reports.',
  };
}

// ------------------------------------------------------------------- badges
// Journey markers exclusive to grassroots — recognition that does not depend
// on being scouted yet. Awarded automatically, never purchasable.
export function earnedGrassrootsBadges(player, { streak = 0 } = {}) {
  const earned = [];
  const apps = player.stats?.appearances ?? 0;
  if ((player.attendance ?? []).length >= 1) earned.push('Turnstile');            // first verified attendance
  if ((player.attendance ?? []).length >= 10) earned.push('Ever-Present');        // ten verified attendances
  if (apps >= 20) earned.push('Season Regular');                                  // a real season of football
  if (streak >= 14) earned.push('Iron Streak');                                   // two weeks of daily activity
  if ((player.drillResults ?? []).filter((r) => r.verified).length >= 3) earned.push('Combine Proven');
  if (player.level === 'semi_pro') earned.push('First Club');                     // the level-up itself
  return earned;
}

// -------------------------------------------------------------- percentiles
// Honest context, not competition: where a value sits among the cohort.
// Returns 0-100 (share of cohort at-or-below this performance) or null when
// the cohort is too small to be meaningful.
export function percentileAmong(value, cohortValues, lowerIsBetter = false) {
  const values = cohortValues.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (values.length < 3) return null;
  const beatenOrMatched = values.filter((v) => (lowerIsBetter ? value <= v : value >= v)).length;
  return Math.round((beatenOrMatched / values.length) * 100);
}

/** Age band ±3 years; position groups mirror the programme tracks. */
export function inCohort(player, other) {
  if (other.level === 'pro') return false;
  const group = (p) => trackForPosition(p.position);
  return group(player) === group(other);
}
