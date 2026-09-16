/**
 * M20 — pipeline shape and where work comes from.
 *
 * Pure functions over the reporting context built in dashboard.mjs. Nothing
 * here touches `db`, nothing here writes, and nothing here reads a note, a
 * comment or a person's name.
 *
 * The one design decision worth stating loudly: **this is not a conversion
 * funnel.** M17 makes reopening first-class — an archived room can go back to
 * under_review, and Second Look exists precisely to cause that. So a room is
 * counted once for each stage it EVER reached, in a set, not once per visit
 * and not as a monotonic drop-off. A club whose rooms cycle is not a club
 * whose funnel is broken.
 */
import {
  METRICS, wire, ratio, count, inWindow, cohortIncomplete, ASSOCIATION_NOTE, SMALL_N_MIN,
} from './metrics.mjs';
import {
  ROOM_STATUSES, TERMINAL_ROOM_STATUSES, SOURCE_CONTEXTS, reasonCategory, REASON_CODES,
} from '../m17/shared.mjs';

/**
 * The ladder the funnel panel renders, in order. It is ROOM_STATUSES minus the
 * three endings that are not progress: a room that was withdrawn did not reach
 * a further stage, it stopped. `signed` stays because it is the end of the
 * ladder rather than a departure from it.
 */
/**
 * M23 added five statuses, and only three of them are progress.
 *
 *   contact_planned, contacted   ARE rungs on the ladder — they are the step
 *                                between reviewing a player and asking them
 *                                for a trial, and M23's own funnel names them.
 *   offer_accepted               IS a rung: it is further than offer_made.
 *
 *   on_hold                      is NOT. A paused case has not advanced; it is
 *                                the same case, waiting. Counting it as a stage
 *                                reached would report pausing as progress.
 *   offer_declined               is NOT. A case that reached offer_declined
 *                                already counted at offer_made, and adding a
 *                                second row would count one piece of progress
 *                                twice — while reading, on a page of
 *                                progression rows, as though declining were a
 *                                further step forward.
 *
 * This is the explicit compatibility mapping M23 §50 asks for rather than a
 * silent change in what the funnel means. Every historical room keeps counting
 * exactly as it did: no existing status changed name, position or inclusion.
 */
export const FUNNEL_NON_PROGRESS_STATUSES = ['withdrawn', 'archived', 'closed', 'on_hold', 'offer_declined'];

export const FUNNEL_STAGES = ROOM_STATUSES.filter((s) => !FUNNEL_NON_PROGRESS_STATUSES.includes(s));

/** Reason-code categories, in a fixed order so two reads never disagree. */
export const REASON_CATEGORIES = Object.keys(REASON_CODES);

/**
 * Every status transition a room ever made, oldest first.
 *
 * Two history actions carry a transition: `room_status_changed` (every change)
 * and `room_reopened` (the M18 Second Look bridge, which writes only the
 * reopen entry). The normal reopen path writes BOTH at the same instant, so
 * identical (at, from, to) triples are collapsed — otherwise every reopen
 * would count twice in every figure derived from here.
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

/** The status a room started in, from its own `room_created` entry. */
export function openedStatus(room) {
  const created = (room.history ?? []).find((h) => h.action === 'room_created');
  return created?.detail?.status ?? null;
}

/** Every status this room has ever been in, including the one it opened in. */
export function stagesReached(room) {
  const seen = new Set();
  const opened = openedStatus(room);
  if (opened) seen.add(opened);
  for (const t of transitions(room)) {
    if (t.from) seen.add(t.from);
    seen.add(t.to);
  }
  // A room whose history predates the created-detail still has a status now.
  if (!seen.size && room.status) seen.add(room.status);
  return seen;
}

/** When the room first reached this status, or null if it never did. */
export function firstReachedAt(room, status) {
  if (openedStatus(room) === status) return room.createdAt;
  for (const t of transitions(room)) if (t.to === status) return t.at;
  return null;
}

/** When the room first reached ANY terminal status, or null. */
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
    // Fixed vocabulary order, not count order: ordering by size would turn a
    // status list into a ranking of nothing.
    rows: ROOM_STATUSES.map((status) => ({ status, terminal: TERMINAL_ROOM_STATUSES.includes(status), ...count(by[status]) })),
  };
}

// ------------------------------------------------------------- F2 · funnel

/**
 * Of the rooms OPENED in the window, how many ever reached each later stage —
 * at any later time, including after the window closed. That last part is why
 * `reachedOutsideWindow` is reported: a director looking at last month's
 * cohort is looking at a story still being written.
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
    // Not a drop-off: the flag exists so the client cannot render this as one.
    monotonic: false,
    reopenedInCohort: count(reopened),
    cohortIncomplete: cohortIncomplete(ctx.window, ctx.typicalDaysToTerminal, ctx.now),
    typicalDaysToTerminal: ctx.typicalDaysToTerminal ?? null,
    rows,
  };
}

// --------------------------------------------------------- F3 · exit reasons

/**
 * For rooms that ENDED in the window, the categories of reason the club
 * recorded. Categories, not codes, are the headline: a code is a club's
 * shorthand, a category is the shape of the club's reasoning.
 *
 * A decision carrying codes in two categories counts in both, so the shares
 * do not sum to 100 and `overlapping: true` says so on the wire.
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
    // Codes are listed in the taxonomy's own order, never by frequency.
    codes: REASON_CATEGORIES.flatMap((cat) => REASON_CODES[cat].map((code) => ({ code, category: cat, ...count(byCode.get(code) ?? 0) })))
      .filter((row) => row.value > 0),
  };
}

// ------------------------------------------------------------ S1 · sources

export function roomSourceMix(ctx) {
  const cohort = ctx.rooms.filter((r) => inWindow(r.createdAt, ctx.window));
  const by = Object.fromEntries(SOURCE_CONTEXTS.map((s) => [s, 0]));
  for (const r of cohort) if (by[r.sourceContext] !== undefined) by[r.sourceContext] += 1;
  return {
    ...wire(METRICS.room_source_mix),
    total: count(cohort.length),
    rows: SOURCE_CONTEXTS.map((source) => ({
      source,
      // `direct` is what an unrecognised context normalises to, so it is a
      // residual bucket rather than a surface anyone used. Saying so here
      // stops the panel reading as "most of our work comes from nowhere".
      residual: source === 'direct',
      ...count(by[source]),
      share: ratio(by[source], cohort.length),
    })).filter((row) => row.value > 0),
  };
}

// ------------------------------------------------- S2 · association, not cause

/**
 * For each source, of the rooms opened from it in the window, how many later
 * reached a trial or beyond.
 *
 * This is the most dangerous figure in M20 and it is built defensively:
 * suppressed below SMALL_N_MIN without exception, ordered alphabetically so it
 * can never be read as a league table of surfaces, and shipped with the
 * association sentence in the payload so a client cannot render the number
 * without it.
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
    .sort(([a], [b]) => a.localeCompare(b))   // alphabetical, never by rate
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
 * M23 P4B (D-29): the Trial workflow as process COUNTS in the window — one
 * number per step, each keyed on the moment the step happened. No rate, no
 * ratio, no "conversion": the mandate says only process metrics, and a
 * completion count beside an invitation count already invites the reader to
 * divide, so the limitation sentence says why they must not.
 */
/**
 * M23 P5 — formal decisions finalized in the window, by outcome. Reads the
 * outcome WORD and two timestamps; never the reason codes, the rationale, the
 * evidence references or anything about the player. Superseded rows still
 * count as decisions that were made; the `superseded` figure says how many.
 */
export function decisionOutcomes(ctx) {
  const w = ctx.window;
  // The context's projected decisions (org-scoped, room-filtered) — not the raw store (D-P5-2).
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
