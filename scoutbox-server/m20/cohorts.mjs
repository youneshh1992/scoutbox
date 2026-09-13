/**
 * M20 — decision record hygiene, coverage of the club's own stated demand, and
 * dynamic watchlists as a work surface.
 *
 * "Decision record hygiene" is a careful name. Nothing in this file measures
 * whether a decision was RIGHT. It measures whether the club wrote down what
 * it did, whether it later revised it, and what kind of reason it recorded —
 * facts about the record, not about the judgement and never about the person
 * who made it.
 *
 * The coverage family answers the one question a director can act on without
 * any opinion about a player at all: *is the demand we ourselves wrote down
 * being worked?*
 */
import { METRICS, wire, ratio, count, distribution, days, inWindow } from './metrics.mjs';
import { REASON_CODES } from '../m17/shared.mjs';
import { briefIsLiveOn } from '../m18/shared.mjs';
import { firstTerminalAt } from './funnels.mjs';

/** The four codes that mean "we could not tell, for want of evidence". */
export const EVIDENCE_REASON_CODES = REASON_CODES.evidence;

// -------------------------------------------- D1 · did the ending get written

export function terminalWithRecordedDecision(ctx) {
  let ended = 0;
  let recorded = 0;
  const missing = [];
  for (const r of ctx.rooms) {
    const at = firstTerminalAt(r);
    if (at == null || !inWindow(at, ctx.window)) continue;
    ended += 1;
    if (ctx.decisionsByRoom.get(r.id)?.length) recorded += 1;
    else missing.push({ roomId: r.id, status: r.status, ...ctx.subjectOf(r) });
  }
  return {
    ...wire(METRICS.terminal_with_recorded_decision),
    ...ratio(recorded, ended),
    ended: count(ended),
    rows: missing.sort((a, b) => String(a.roomId).localeCompare(String(b.roomId))),
  };
}

// ------------------------------------------------------ D2 · revised endings

export function supersededDecisionRate(ctx) {
  const inWin = ctx.decisions.filter((d) => inWindow(d.createdAt, ctx.window));
  const superseded = inWin.filter((d) => d.supersededById).length;
  return {
    ...wire(METRICS.superseded_decision_rate),
    ...ratio(superseded, inWin.length),
    // Rendered deliberately without a good/bad colour. Changing your mind on
    // new information is the behaviour Second Look was built to produce.
    neutral: true,
  };
}

// ------------------------------------------- D3 · endings limited by evidence

/**
 * The one figure in M20 that points at something a director can actually fix.
 * If a third of endings are recorded as "we could not tell", the constraint is
 * the club's evidence pipeline, not its judgement — and unlike almost every
 * other analytics number, acting on it changes a process rather than a person.
 */
export function evidenceLimitedExits(ctx) {
  let ended = 0;
  let evidenceLimited = 0;
  const byCode = Object.fromEntries(EVIDENCE_REASON_CODES.map((c) => [c, 0]));
  for (const r of ctx.rooms) {
    const at = firstTerminalAt(r);
    if (at == null || !inWindow(at, ctx.window)) continue;
    const ds = ctx.decisionsByRoom.get(r.id) ?? [];
    if (!ds.length) continue;
    ended += 1;
    const codes = new Set(ds.flatMap((d) => (Array.isArray(d.reasonCodes) ? d.reasonCodes : [])));
    let hit = false;
    for (const c of EVIDENCE_REASON_CODES) if (codes.has(c)) { byCode[c] += 1; hit = true; }
    if (hit) evidenceLimited += 1;
  }
  return {
    ...wire(METRICS.evidence_limited_exits),
    ...ratio(evidenceLimited, ended),
    ended: count(ended),
    rows: EVIDENCE_REASON_CODES.map((code) => ({ code, ...count(byCode[code]) })),
  };
}

// ---------------------------------------------------------- D4 · reopening

export function reopenRate(ctx) {
  let endedInWindow = 0;
  let reopened = 0;
  for (const r of ctx.rooms) {
    const at = firstTerminalAt(r);
    if (at == null || !inWindow(at, ctx.window)) continue;
    endedInWindow += 1;
    // Any transition after the first ending is a reopening, whether it came
    // through the Room's own reopen path or through Second Look's bridge.
    if ((r.transitions ?? []).some((t) => t.at > at)) reopened += 1;
  }
  return {
    ...wire(METRICS.reopen_rate),
    ...ratio(reopened, endedInWindow),
    ended: count(endedInWindow),
    neutral: true,
  };
}

// ---------------------------------------------------------- C1 · live briefs

export function briefsLive(ctx) {
  // Point-in-time: liveness is asked of TODAY, never of the window's end.
  // "Which briefs were live last March" is a different question this build
  // does not answer, and answering it approximately would be worse.
  const live = ctx.briefs.filter((b) => briefIsLiveOn(b, ctx.today));
  return {
    ...wire(METRICS.briefs_live),
    ...count(live.length),
    total: count(ctx.briefs.length),
    byStatus: ['draft', 'active', 'paused', 'closed', 'archived']
      .map((status) => ({ status, ...count(ctx.briefs.filter((b) => b.status === status).length) })),
    rows: live
      .slice()
      .sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')))
      .map((b) => ({ briefId: b.id, title: b.title, version: b.version })),
  };
}

// -------------------------------------------- C2/C3 · is the demand worked

/**
 * Nobody Missed surfaces players who are eligible under the club's OWN brief
 * and have not entered its evaluation workflow. Backlog is how many are still
 * untouched; the review rate is how many the club has looked at.
 *
 * Dismissing a candidate counts as reviewing them. That is intentional: the
 * question is whether the club looked, not what it concluded — the second
 * question is a football judgement and none of ScoutBox's business.
 */
export function nobodyMissedCoverage(ctx) {
  const liveIds = new Set(ctx.briefs.filter((b) => briefIsLiveOn(b, ctx.today)).map((b) => b.id));
  const rel = ctx.nmReviews.filter((r) => liveIds.has(r.briefId));
  const open = rel.filter((r) => r.state === 'open');
  const perBrief = [...liveIds].map((briefId) => {
    const forBrief = rel.filter((r) => r.briefId === briefId);
    const brief = ctx.briefs.find((b) => b.id === briefId);
    return {
      briefId,
      title: brief?.title ?? null,
      ...count(forBrief.filter((r) => r.state === 'open').length),
      reviewed: ratio(forBrief.filter((r) => r.state !== 'open').length, forBrief.length),
    };
  }).sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')));
  return {
    backlog: {
      ...wire(METRICS.nobody_missed_backlog),
      ...count(open.length),
      liveBriefs: count(liveIds.size),
      rows: perBrief,
    },
    reviewRate: {
      ...wire(METRICS.nobody_missed_review_rate),
      ...ratio(rel.filter((r) => r.state !== 'open').length, rel.length),
    },
  };
}

// ------------------------------------------------------------- C4/C5 · Second Look

export function secondLookCoverage(ctx) {
  const items = ctx.secondLook;
  const open = items.filter((i) => i.status === 'open');
  const responded = items.filter((i) => i.status !== 'open' && Number(i.updatedAt) > Number(i.createdAt));
  const values = responded
    .filter((i) => inWindow(i.updatedAt, ctx.window))
    .map((i) => days(i.createdAt, i.updatedAt));
  return {
    backlog: {
      ...wire(METRICS.second_look_backlog),
      ...count(open.length),
      // Expiry is a designed outcome, not neglect, so it is counted apart.
      expired: count(items.filter((i) => i.status === 'expired').length),
      reopenedRoom: count(items.filter((i) => i.status === 'reopened_room').length),
      age: distribution(open.map((i) => days(i.createdAt, ctx.now))),
    },
    responseTime: {
      ...wire(METRICS.second_look_response_time),
      ...distribution(values, { excluded: open.length }),
      excludedMeans: 'Second Look items nobody has touched yet. They have no response time to measure, which is exactly why the backlog is shown next to this.',
    },
  };
}

// ------------------------------------------------------------- W1/W2 · lists

export function watchlistActivity(ctx) {
  const active = ctx.watchlists.filter((w) => w.status === 'active');
  const events = ctx.watchlistHistory.filter((h) => inWindow(h.at, ctx.window));
  const entered = events.filter((h) => h.transition === 'entered').length;
  const left = events.filter((h) => h.transition === 'left').length;
  return {
    active: {
      ...wire(METRICS.active_watchlists),
      ...count(active.length),
      total: count(ctx.watchlists.length),
      byStatus: ['active', 'paused', 'archived']
        .map((status) => ({ status, ...count(ctx.watchlists.filter((w) => w.status === status).length) })),
    },
    churn: {
      ...wire(METRICS.watchlist_membership_churn),
      ...count(events.length),
      entered: count(entered),
      left: count(left),
      // Without this the number reads as "players whose situation changed",
      // which it is not. M19 has no scheduler: membership is worked out when
      // somebody opens a list, so this counts recalculations.
      derivedOnRead: true,
      refreshNote: 'ScoutBox does not recompute watchlists in the background. These are the changes found when someone opened a list — a list nobody opened records nothing.',
    },
  };
}

export const DECISION_METRICS = { terminalWithRecordedDecision, supersededDecisionRate, evidenceLimitedExits, reopenRate };
export const COVERAGE_METRICS = { briefsLive, nobodyMissedCoverage, secondLookCoverage };
export const WATCHLIST_METRICS = { watchlistActivity };
