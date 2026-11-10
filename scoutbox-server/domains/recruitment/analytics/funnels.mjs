/**
 * Recruitment analytics: pipeline shape and where work comes from. Pure functions over the reporting context
 * built in dashboard.mjs.
 *
 * This is not a conversion funnel. Rooms can be reopened (Second Look exists to cause that), so a room counts
 * once for each stage it ever reached, not as a monotonic drop-off.
 */
import {
  METRICS, wire, ratio, count, inWindow, cohortIncomplete, ASSOCIATION_NOTE, SMALL_N_MIN,
} from './metrics.mjs';
import {
  ROOM_STATUSES, TERMINAL_ROOM_STATUSES, SOURCE_CONTEXTS, reasonCategory, REASON_CODES,
} from '../rooms/shared.mjs';

/**
 * The statuses that are not progress: the three endings, `on_hold` (a paused case has not advanced) and
 * `offer_declined` (it already counted at offer_made, and a further row would read declining as a step
 * forward). `contact_planned`, `contacted` and `offer_accepted` are rungs; `signed` ends the ladder.
 */
export const FUNNEL_NON_PROGRESS_STATUSES = ['withdrawn', 'archived', 'closed', 'on_hold', 'offer_declined'];

export const FUNNEL_STAGES = ROOM_STATUSES.filter((s) => !FUNNEL_NON_PROGRESS_STATUSES.includes(s));

/** In a fixed order so two reads never disagree. */
export const REASON_CATEGORIES = Object.keys(REASON_CODES);

/**
 * Every status transition, oldest first. The normal reopen path writes both `room_status_changed` and
 * `room_reopened` at the same instant (the Second Look bridge writes only the latter), so identical
 * (at, from, to) triples are collapsed or every reopen would count twice.
 */
export function transitions(room) {
  const out = [];
  for (const h of room.history ?? []) {
    if (h.action !== 'room_status_changed' && h.action !== 'room_reopened') continue;
    const to = h.detail?.to;
    if (!to) continue;
    const from = h.detail?.from ?? null;
    const last = out[out.length - 1];
    if (last && last.at === h.at && last.from === from && last.to === to) continue;
    out.push({ at: h.at, from, to, reopen: h.action === 'room_reopened' });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function openedStatus(room) {
  const created = (room.history ?? []).find((h) => h.action === 'room_created');
  return created?.detail?.status ?? null;
}

/** Includes the status it opened in. */
export function stagesReached(room) {
  const seen = new Set();
  const opened = openedStatus(room);
  if (opened) seen.add(opened);
  for (const t of transitions(room)) {
    if (t.from) seen.add(t.from);
    seen.add(t.to);
  }
  // A room whose history has no created-detail still has a status now.
  if (!seen.size && room.status) seen.add(room.status);
  return seen;
}

export function firstReachedAt(room, status) {
  if (openedStatus(room) === status) return room.createdAt;
  for (const t of transitions(room)) if (t.to === status) return t.at;
  return null;
}

export function firstTerminalAt(room) {
  for (const t of transitions(room)) if (TERMINAL_ROOM_STATUSES.includes(t.to)) return t.at;
  return null;
}

// ------------------------------------------------------------ F1 · statuses

export function pipelineStageCounts(ctx) {
  const by = Object.fromEntries(ROOM_STATUSES.map((s) => [s, 0]));
  for (const r of ctx.rooms) if (by[r.status] !== undefined) by[r.status] += 1;
  return {
    ...wire(METRICS.pipeline_stage_counts),
    total: count(ctx.rooms.length),
    // Vocabulary order: ordering by size would turn a status list into a ranking.
    rows: ROOM_STATUSES.map((status) => ({ status, terminal: TERMINAL_ROOM_STATUSES.includes(status), ...count(by[status]) })),
  };
}

// ------------------------------------------------------------- F2 · funnel

/**
 * Of the rooms opened in the window, how many ever reached each later stage, including after the window
 * closed; `reachedOutsideWindow` says how many, since a recent cohort is a story still being written.
 */
export function funnelProgression(ctx) {
  const cohort = ctx.rooms.filter((r) => inWindow(r.createdAt, ctx.window));
  const n = cohort.length;
  const rows = FUNNEL_STAGES.map((stage) => {
    let reached = 0;
    let outside = 0;
    for (const r of cohort) {
      const at = firstReachedAt(r, stage);
      if (at == null) continue;
      reached += 1;
      if (!inWindow(at, ctx.window)) outside += 1;
    }
    return {
      stage,
      ...count(reached),
      reachedOutsideWindow: outside,
      share: ratio(reached, n),
    };
  });
  const reopened = cohort.filter((r) => transitions(r).some((t) => t.reopen)).length;
  return {
    ...wire(METRICS.funnel_progression),
    cohort: count(n),
    // Tells the client not to render this as a drop-off.
    monotonic: false,
    reopenedInCohort: count(reopened),
    cohortIncomplete: cohortIncomplete(ctx.window, ctx.typicalDaysToTerminal, ctx.now),
    typicalDaysToTerminal: ctx.typicalDaysToTerminal ?? null,
    rows,
  };
}

// --------------------------------------------------------- F3 · exit reasons

/**
 * For rooms that ended in the window, the reason categories recorded. A decision with codes in two
 * categories counts in both, so shares do not sum to 100 (`overlapping: true`).
 */
export function exitReasonMix(ctx) {
  const decisions = [];
  for (const r of ctx.rooms) {
    const endedAt = firstTerminalAt(r);
    if (endedAt == null || !inWindow(endedAt, ctx.window)) continue;
    for (const d of ctx.decisionsByRoom.get(r.id) ?? []) decisions.push(d);
  }
  const n = decisions.length;
  const byCategory = Object.fromEntries(REASON_CATEGORIES.map((c) => [c, 0]));
  const byCode = new Map();
  let uncoded = 0;
  for (const d of decisions) {
    const codes = Array.isArray(d.reasonCodes) ? d.reasonCodes : [];
    if (!codes.length) uncoded += 1;
    const cats = new Set();
    for (const c of codes) {
      byCode.set(c, (byCode.get(c) ?? 0) + 1);
      const cat = reasonCategory(c);
      if (cat) cats.add(cat);
    }
    for (const cat of cats) byCategory[cat] += 1;
  }
  return {
    ...wire(METRICS.exit_reason_mix),
    total: count(n),
    overlapping: true,
    uncoded: count(uncoded),
    rows: REASON_CATEGORIES.map((category) => ({ category, ...count(byCategory[category]), share: ratio(byCategory[category], n) })),
    // Taxonomy order, never by frequency.
    codes: REASON_CATEGORIES.flatMap((cat) => REASON_CODES[cat].map((code) => ({ code, category: cat, ...count(byCode.get(code) ?? 0) })))
      .filter((row) => row.value > 0),
  };
}

// ------------------------------------------------------------ sources

export function roomSourceMix(ctx) {
  const cohort = ctx.rooms.filter((r) => inWindow(r.createdAt, ctx.window));
  const by = Object.fromEntries(SOURCE_CONTEXTS.map((s) => [s, 0]));
  for (const r of cohort) if (by[r.sourceContext] !== undefined) by[r.sourceContext] += 1;
  return {
    ...wire(METRICS.room_source_mix),
    total: count(cohort.length),
    rows: SOURCE_CONTEXTS.map((source) => ({
      source,
      // An unrecognised context normalises to `direct`, so it is a residual bucket, not a surface anyone used.
      residual: source === 'direct',
      ...count(by[source]),
      share: ratio(by[source], cohort.length),
    })).filter((row) => row.value > 0),
  };
}

// ------------------------------------------------- association, not cause

/**
 * Per source, how many rooms opened in the window later reached each stage. Built defensively: suppressed
 * below SMALL_N_MIN, ordered alphabetically so it never reads as a league table of surfaces, and shipped
 * with the association sentence.
 */
export const REACH_STAGES = ['trial_requested', 'offer_made', 'signed'];

export function sourceStageReach(ctx) {
  const cohort = ctx.rooms.filter((r) => inWindow(r.createdAt, ctx.window));
  const bySource = new Map();
  for (const r of cohort) {
    const key = r.sourceContext ?? 'direct';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(r);
  }
  const rows = [...bySource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, group]) => ({
      source,
      cohort: count(group.length),
      stages: REACH_STAGES.map((stage) => ({
        stage,
        ...ratio(group.filter((r) => firstReachedAt(r, stage) != null).length, group.length),
      })),
    }));
  return {
    ...wire(METRICS.source_stage_reach),
    associationOnly: true,
    associationNote: ASSOCIATION_NOTE,
    ordering: 'source_name_asc',
    minimum: SMALL_N_MIN,
    rows,
  };
}

export const PIPELINE_METRICS = { pipelineStageCounts, funnelProgression, exitReasonMix };
export const SOURCE_METRICS = { roomSourceMix, sourceStageReach };

// ----------------------------------------------------- F4 · trial process

/**
 * Formal decisions finalised in the window, by outcome. Reads only the outcome word and timestamps.
 * Superseded rows still count as decisions made; `superseded` says how many.
 */
export function decisionOutcomes(ctx) {
  const w = ctx.window;
  const rows = (ctx.decisions ?? []).filter((d) => d && typeof d === 'object' && d.kind === 'formal' && d.state !== 'draft' && inWindow(d.createdAt, w));
  const by = { progress: 0, hold: 0, reject: 0 };
  for (const d of rows) if (Object.prototype.hasOwnProperty.call(by, d.outcome)) by[d.outcome] += 1;
  return {
    ...wire(METRICS.decision_outcomes),
    ...count(rows.length),
    outcomes: Object.fromEntries(Object.entries(by).map(([k, n]) => [k, count(n)])),
    superseded: count(rows.filter((d) => d.supersededById).length),
    note: 'Formal decisions finalized in the window, by outcome. Counts only; no rate, no ranking, no reason.',
  };
}

/**
 * Process counts per step, each keyed on when the step happened. No rate: a completion count beside an
 * invitation count invites dividing, and the limitation sentence says why not to.
 */
export function trialProcess(ctx) {
  const w = ctx.window;
  const invitations = (ctx.requests ?? []).filter((r) => r && r.type === 'trial' && r.caseId);
  const trials = (ctx.trials ?? []).filter((t) => t && typeof t === 'object' && t.caseId);
  const steps = {
    invited: invitations.filter((r) => inWindow(r.createdAt, w)).length,
    declined: invitations.filter((r) => r.status === 'declined' && inWindow(r.respondedAt, w)).length,
    accepted: trials.filter((t) => inWindow(t.acceptedAt, w)).length,
    scheduled: trials.filter((t) => inWindow(t.schedule?.confirmedAt, w)).length,
    completed: trials.filter((t) => t.completion?.state === 'completed' && inWindow(t.completion.at, w)).length,
    cancelled: trials.filter((t) => t.completion?.state === 'cancelled' && inWindow(t.completion.at, w)).length,
  };
  return {
    ...wire(METRICS.trial_process),
    ...count(steps.completed),
    steps: Object.fromEntries(Object.entries(steps).map(([k, n]) => [k, count(n)])),
    note: 'Each step is counted on the day it happened, so one trial can appear under several steps in one window and under none in another. Counts are never suppressed; no rate is offered.',
  };
}


// ------------------------------------------------------------ journey funnel

/** The instant that proves each journey stage, or null. */
const JOURNEY_EVIDENCE = Object.freeze({
  contacted: (k, x) => firstAt(x.contactsByCase.get(k.id), (c) => ['delivered', 'responded', 'recorded'].includes(c.status) && !c.cancelledAt, (c) => c.deliveredAt ?? c.occurredAt ?? c.recordedAt),
  trial_requested: (k, x) => firstAt(x.requestsByCase.get(k.id), (r) => r.type === 'trial', (r) => r.createdAt),
  trial_scheduled: (k, x) => firstAt(x.trialsByCase.get(k.id), (t) => Number.isFinite(t.schedule?.confirmedAt) || t.completion?.state === 'completed', (t) => t.schedule?.confirmedAt ?? t.completion?.at),
  trial_completed: (k, x) => firstAt(x.trialsByCase.get(k.id), (t) => t.completion?.state === 'completed', (t) => t.completion?.at),
  // An assessment counts for one case: the one whose Trial it was written in, else the case open when it was
  // written. A second case never claims an ended case's assessment.
  assessed: (k, x) => firstAt(x.assessmentsByPlayer.get(k.playerId), (a) => a.state !== 'draft' && assessmentOfCase(a, k, x), (a) => a.submittedAt ?? a.createdAt),
  decision_progress: (k, x) => decisionAt(x.decisionsByCase.get(k.id), 'progress'),
  decision_hold: (k, x) => decisionAt(x.decisionsByCase.get(k.id), 'hold'),
  decision_reject: (k, x) => decisionAt(x.decisionsByCase.get(k.id), 'reject'),
  offer_issued: (k, x) => firstAt(x.offersByCase.get(k.id), (o) => (o.revisions ?? []).some((r) => r && r.issuedAt && r.status !== 'DRAFT'), (o) => Math.min(...(o.revisions ?? []).filter((r) => r && r.issuedAt).map((r) => Number(r.issuedAt)))),
  offer_accepted: (k, x) => firstAt(x.offersByCase.get(k.id), (o) => (o.revisions ?? []).some((r) => r && r.status === 'ACCEPTED'), (o) => (o.revisions ?? []).find((r) => r && r.status === 'ACCEPTED')?.respondedAt),
  offer_declined: (k, x) => firstAt(x.offersByCase.get(k.id), (o) => (o.revisions ?? []).some((r) => r && r.status === 'DECLINED'), (o) => (o.revisions ?? []).find((r) => r && r.status === 'DECLINED')?.respondedAt),
  signing_started: (k, x) => firstAt(x.packagesByCase.get(k.id), () => true, (p) => p.createdAt),
  signed: (k, x) => {
    // A canonical row: a COMPLETED package on this case that names the row back. A legacy row: no package,
    // recorded after the case opened.
    const pkgs = x.packagesByCase.get(k.id) ?? [];
    for (const p of pkgs) { if (p.status === 'COMPLETED' && p.completion?.signingId) { const row = x.signingsById.get(p.completion.signingId); if (row && row.signingPackageId === p.id && !row.cancelledAt) return Number(p.completion.completedAt) || Number(row.ts) || null; } }
    const legacy = (x.signingsByPlayer.get(k.playerId) ?? []).filter((s) => !s.signingPackageId && !s.cancelledAt && !s.voidedAt && (!Number.isFinite(Number(k.createdAt)) || Number(s.ts) >= Number(k.createdAt)));
    return legacy.length ? Math.min(...legacy.map((s) => Number(s.ts))) : null;
  },
});
/** The status whose history entry is each stage's "history only" counterpart. */
const JOURNEY_STAGE_STATUS = Object.freeze({ contacted: 'contacted', trial_requested: 'trial_requested', trial_scheduled: 'trial_scheduled', trial_completed: 'trial_completed', decision_progress: 'offer_consideration', offer_issued: 'offer_made', offer_accepted: 'offer_accepted', offer_declined: 'offer_declined', signed: 'signed' });
export const JOURNEY_FUNNEL_STAGES = Object.freeze(Object.keys(JOURNEY_EVIDENCE));
const SOURCE_OF = Object.freeze({ contacted: 'recruitmentContacts', trial_requested: 'requests', trial_scheduled: 'trials', trial_completed: 'trials', assessed: 'assessments', decision_progress: 'roomDecisions', decision_hold: 'roomDecisions', decision_reject: 'roomDecisions', offer_issued: 'recruitmentOffers', offer_accepted: 'recruitmentOffers', offer_declined: 'recruitmentOffers', signing_started: 'signingPackages', signed: 'signings' });

/** The latest terminal transition if the case is terminal now; a reopened case is open again (Infinity). */
function caseEndedAt(k) {
  const status = k.room?.status ?? k.status ?? null;
  if (!TERMINAL_ROOM_STATUSES.includes(status)) return Infinity;
  const ends = transitions(k).filter((t) => TERMINAL_ROOM_STATUSES.includes(t.to)).map((t) => Number(t.at) || 0);
  return ends.length ? Math.max(...ends) : 0;
}
/** Mirrors ownedByAnotherCase in domains/recruitment/lifecycle/journey.mjs. */
function assessmentOfCase(a, k, x) {
  const tid = a?.context?.trialId;
  if (typeof tid === 'string' && tid) { const t = x.trialsById.get(tid); return !!t && t.caseId === k.id; }
  const at = Number(a?.submittedAt ?? a?.createdAt);
  if (!Number.isFinite(at)) return false;
  return !(x.casesByPlayer.get(k.playerId) ?? []).some((o) => o && o.id !== k.id && Number(o.createdAt) <= at && at <= caseEndedAt(o));
}
function firstAt(rows, pred, atOf) {
  let best = null;
  for (const r of rows ?? []) { if (!r || !pred(r)) continue; const t = Number(atOf(r)); if (!Number.isFinite(t) || t <= 0) continue; if (best === null || t < best) best = t; }
  return best;
}
function decisionAt(rows, outcome) {
  // The standing formal decision (nothing supersedes it) with this outcome.
  const heads = (rows ?? []).filter((d) => d && d.kind === 'formal' && d.state !== 'draft' && !d.supersededById && d.outcome === outcome);
  return heads.length ? Math.min(...heads.map((d) => Number(d.createdAt) || Infinity)) : null;
}
const groupBy = (rows, keyOf) => { const m = new Map(); for (const r of rows ?? []) { if (!r) continue; const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const mid = Math.floor(a.length / 2); return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2; };
const days = (ms) => Math.round((ms / 86_400_000) * 10) / 10;

/**
 * Cohort: cases opened in the window, the same rule as `funnel_progression`. A case counts once per stage.
 * `historyOnly` counts cohort cases whose history reached the stage with no record behind it, never added.
 * `intervals` are medians, in days, over cases with both ends recorded.
 */
export function journeyEvidenceFunnel(ctx) {
  const w = ctx.window;
  const cohort = (ctx.rooms ?? []).filter((k) => k && inWindow(k.createdAt, w));
  const x = {
    contactsByCase: groupBy(ctx.contacts, (c) => c.caseId),
    requestsByCase: groupBy(ctx.requests, (r) => r.caseId),
    trialsByCase: groupBy(ctx.trials, (t) => t.caseId),
    assessmentsByPlayer: groupBy(ctx.assessments, (a) => a.playerId),
    trialsById: new Map((ctx.trials ?? []).filter(Boolean).map((t) => [t.id, t])),
    casesByPlayer: groupBy(ctx.rooms, (k) => k.playerId),
    decisionsByCase: groupBy(ctx.decisions, (d) => d.roomId),
    offersByCase: groupBy(ctx.offers, (o) => o.caseId),
    packagesByCase: groupBy(ctx.packages, (p) => p.caseId),
    signingsById: new Map((ctx.signings ?? []).filter(Boolean).map((s) => [s.id, s])),
    signingsByPlayer: groupBy(ctx.signings, (s) => s.playerId),
  };
  const reached = (k, status) => (k.history ?? []).some((h) => h && h.action === 'room_status_changed' && h.detail?.to === status) || k.room?.status === status;
  const rows = [];
  const instants = new Map(); // stage → Map(caseId → at)
  for (const stage of JOURNEY_FUNNEL_STAGES) {
    let value = 0; let historyOnly = 0; const m = new Map();
    for (const k of cohort) {
      const at = JOURNEY_EVIDENCE[stage](k, x);
      if (at !== null) { value += 1; m.set(k.id, at); }
      else if (JOURNEY_STAGE_STATUS[stage] && reached(k, JOURNEY_STAGE_STATUS[stage])) historyOnly += 1;
    }
    instants.set(stage, m);
    rows.push({ stage, value, historyOnly, basis: 'case', source: SOURCE_OF[stage] });
  }
  const between = (a, b) => { const ma = instants.get(a); const mb = instants.get(b); const xs = []; for (const [id, t1] of ma) { const t2 = mb.get(id); if (Number.isFinite(t2) && t2 >= t1) xs.push(t2 - t1); } return { n: xs.length, medianDays: xs.length ? days(median(xs)) : null }; };
  const intervals = {
    contact_to_trial: between('contacted', 'trial_scheduled'),
    trial_completed_to_decision: between('trial_completed', 'decision_progress'),
    decision_to_offer: between('decision_progress', 'offer_issued'),
    offer_issued_to_accepted: between('offer_issued', 'offer_accepted'),
    accepted_to_signed: between('offer_accepted', 'signed'),
  };
  return {
    ...wire(METRICS.journey_evidence_funnel),
    ...count(cohort.length),
    cohort: count(cohort.length),
    rows,
    intervals,
    counting: 'case',
    note: 'Each stage counts cases with the record that proves it. "History only" counts cohort cases whose status history reached the stage with no such record (older cases), shown apart and never added. Intervals are medians of the records\' own instants, in days.',
  };
}
