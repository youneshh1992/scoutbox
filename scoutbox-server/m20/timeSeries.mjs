/**
 * M20 — how long the process takes, and what has stopped moving.
 *
 * Pure functions over the reporting context. Two rules run through every
 * function here:
 *
 *   1. **Medians, never means.** One eighteen-month room would move a mean
 *      and tell a director nothing true about the other forty.
 *   2. **The exclusion is reported.** Every duration is computed over the
 *      records that FINISHED, which quietly flatters a club whose work is
 *      stuck: the rooms still sitting in a stage contribute nothing to that
 *      stage's median. So every duration ships with the count it could not
 *      include, and the aging family exists to catch exactly what the
 *      duration family cannot see.
 */
import { METRICS, wire, distribution, count, days, inWindow, DAY_MS } from './metrics.mjs';
import { OPEN_ROOM_STATUSES, ROOM_STATUSES } from '../m17/shared.mjs';
import { transitions, openedStatus, firstReachedAt } from './funnels.mjs';

/** The last moment anything at all was written to this room. */
export const lastActivityAt = (room) =>
  (room.history ?? []).reduce((m, h) => Math.max(m, h.at ?? 0), room.createdAt ?? 0);

/**
 * Every COMPLETED visit this room made to a status: which status, when it
 * started, when it ended. The visit the room is in right now is deliberately
 * absent — it has not finished, and guessing its length would be inventing a
 * timestamp.
 */
export function stageVisits(room) {
  const ts = transitions(room);
  const out = [];
  let status = openedStatus(room) ?? null;
  let since = room.createdAt;
  for (const t of ts) {
    if (status) out.push({ status, from: since, to: t.at, ms: t.at - since });
    status = t.to;
    since = t.at;
  }
  return out.filter((v) => v.ms >= 0);
}

// -------------------------------------------------- T1 · time to a decision

export function timeToFirstDecision(ctx) {
  const values = [];
  for (const r of ctx.rooms) {
    const ds = ctx.decisionsByRoom.get(r.id);
    if (!ds?.length) continue;
    const first = ds[0];                       // decisionsByRoom is sorted by createdAt
    if (!inWindow(first.createdAt, ctx.window)) continue;
    values.push(days(r.createdAt, first.createdAt));
  }
  const excluded = ctx.rooms.filter((r) => !(ctx.decisionsByRoom.get(r.id)?.length)).length;
  return {
    ...wire(METRICS.time_to_first_decision),
    ...distribution(values, { excluded }),
    excludedMeans: 'Rooms with no recorded decision at all. They cannot contribute a duration, so this figure describes the rooms that reached a decision — not all of your rooms.',
  };
}

// ----------------------------------------------------- T2 · time in a stage

export function timeInStage(ctx) {
  const byStatus = new Map(ROOM_STATUSES.map((s) => [s, []]));
  let stillIn = 0;
  for (const r of ctx.rooms) {
    for (const v of stageVisits(r)) {
      if (!inWindow(v.to, ctx.window)) continue;     // the EXIT falls in the window
      byStatus.get(v.status)?.push(v.ms / DAY_MS);
    }
    if (OPEN_ROOM_STATUSES.includes(r.status)) stillIn += 1;
  }
  return {
    ...wire(METRICS.time_in_stage),
    // Fixed vocabulary order. Sorting these by duration would produce a
    // "slowest stage" ranking that the exclusion below makes untrue.
    rows: ROOM_STATUSES.map((status) => ({ status, ...distribution(byStatus.get(status) ?? []) }))
      .filter((row) => row.n > 0),
    stillInAStage: count(stillIn),
    excludedMeans: 'Only visits that ENDED are measured. A stage where everything is stuck looks fast here, because the rooms still sitting in it are not counted. Read this next to Rooms with no recent activity.',
  };
}

// ------------------------------------------------------ T3/T4 · trial timing

export function timeToTrialRequested(ctx) {
  const values = [];
  for (const r of ctx.rooms) {
    const at = firstReachedAt(r, 'trial_requested');
    if (at == null || !inWindow(at, ctx.window)) continue;
    values.push(days(r.createdAt, at));
  }
  const excluded = ctx.rooms.filter((r) => firstReachedAt(r, 'trial_requested') == null).length;
  return {
    ...wire(METRICS.time_to_trial_requested),
    ...distribution(values, { excluded }),
    excludedMeans: 'Rooms that never reached a trial request. Most rooms never will, and that is not a fault in the club or in any player.',
  };
}

export function timeTrialRequestedToCompleted(ctx) {
  const values = [];
  let unfinished = 0;
  for (const r of ctx.rooms) {
    const req = firstReachedAt(r, 'trial_requested');
    if (req == null) continue;
    const done = firstReachedAt(r, 'trial_completed');
    if (done == null) { unfinished += 1; continue; }
    if (!inWindow(done, ctx.window)) continue;
    if (done < req) continue;      // a reopened room can reach these out of order
    values.push(days(req, done));
  }
  return {
    ...wire(METRICS.time_trial_requested_to_completed),
    ...distribution(values, { excluded: unfinished }),
    excludedMeans: 'Trials requested but not yet recorded as completed.',
  };
}

// ------------------------------------------------------- T5 · age of the open

/**
 * Age buckets for open rooms. A distribution says what the middle looks like;
 * buckets say where the work is piling up, which is the question a director
 * actually has. Both are shown, because either alone misleads: a median of 20
 * days hides the four rooms sitting at 200.
 */
export const AGE_BUCKETS = [
  { id: '0_7', label: '0–7 days', min: 0, max: 7 },
  { id: '8_14', label: '8–14 days', min: 8, max: 14 },
  { id: '15_30', label: '15–30 days', min: 15, max: 30 },
  { id: '31_60', label: '31–60 days', min: 31, max: 60 },
  { id: '60_plus', label: 'Over 60 days', min: 61, max: Infinity },
];

export function openRoomAge(ctx) {
  const open = ctx.rooms.filter((r) => OPEN_ROOM_STATUSES.includes(r.status));
  const ages = open.map((r) => days(r.createdAt, ctx.now));
  return {
    ...wire(METRICS.open_room_age),
    ...distribution(ages),
    openRooms: count(open.length),
    // Counts, so never suppressed: a club with three old rooms must be able
    // to see all three.
    buckets: AGE_BUCKETS.map((b) => ({
      id: b.id,
      label: b.label,
      ...count(ages.filter((a) => Math.floor(a) >= b.min && Math.floor(a) <= b.max).length),
    })),
  };
}

// -------------------------------------------------------- A1 · stalled work

/** The thresholds a director can choose between. Nothing else is accepted. */
export const STALL_THRESHOLDS = [14, 30, 90];
export const DEFAULT_STALL_DAYS = 30;

export function stalledRooms(ctx, { thresholdDays = DEFAULT_STALL_DAYS } = {}) {
  const threshold = STALL_THRESHOLDS.includes(Number(thresholdDays)) ? Number(thresholdDays) : DEFAULT_STALL_DAYS;
  const open = ctx.rooms.filter((r) => OPEN_ROOM_STATUSES.includes(r.status));
  const aged = open.map((r) => ({ room: r, idleDays: days(lastActivityAt(r), ctx.now) }));
  const rows = aged
    .filter((a) => a.idleDays >= threshold)
    // Oldest first, then id: a stable order across reads, as M18.2 requires.
    .sort((a, b) => (b.idleDays - a.idleDays) || String(a.room.id).localeCompare(String(b.room.id)))
    .map((a) => ({
      roomId: a.room.id,
      status: a.room.status,
      idleDays: Math.floor(a.idleDays),
      ...ctx.subjectOf(a.room),
    }));
  return {
    ...wire(METRICS.stalled_rooms),
    thresholdDays: threshold,
    thresholds: STALL_THRESHOLDS.map((d) => ({ days: d, ...count(aged.filter((a) => a.idleDays >= d).length) })),
    openRooms: count(open.length),
    ...count(rows.length),
    rows,
  };
}

// --------------------------------------------------- A2 · overdue obligations

export function overdueTrialReports(ctx) {
  // M23 P4A-D1/D14: a missing deadline is unknown, not overdue (Number(null)
  // is 0), and a trial whose subject removed their account is no longer an
  // obligation anyone can meet.
  const awaiting = ctx.trials.filter((t) => t.status === 'awaiting_report' && !t.subjectRemovedAt);
  const late = awaiting.filter((t) => Number.isFinite(t.reportDueAt) && t.reportDueAt < ctx.now);
  return {
    ...wire(METRICS.overdue_trial_reports),
    ...count(late.length),
    awaitingReport: count(awaiting.length),
    rows: late
      .slice()
      .sort((a, b) => (a.reportDueAt - b.reportDueAt) || String(a.id).localeCompare(String(b.id)))
      .map((t) => ({ trialId: t.id, overdueDays: Math.floor(days(t.reportDueAt, ctx.now)) })),
    note: 'Unfiled trial reports already block new trial requests. This is the same rule, seen from the top.',
  };
}

// ----------------------------------------------------- A3 · decision missing

/** The statuses M17 itself treats as owing a decision. One definition, not two. */
export const DECISION_OWED_STATUSES = ['offer_consideration', 'offer_made'];

export function decisionOutstanding(ctx) {
  const owed = ctx.rooms.filter((r) => DECISION_OWED_STATUSES.includes(r.status));
  const missing = owed.filter((r) => !(ctx.decisionsByRoom.get(r.id)?.length));
  return {
    ...wire(METRICS.decision_outstanding),
    ...count(missing.length),
    atOfferStage: count(owed.length),
    rows: missing
      .slice()
      .sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)))
      .map((r) => ({ roomId: r.id, status: r.status, ...ctx.subjectOf(r) })),
  };
}

export const DURATION_METRICS = {
  timeToFirstDecision, timeInStage, timeToTrialRequested, timeTrialRequestedToCompleted, openRoomAge,
};
export const AGING_METRICS = { stalledRooms, overdueTrialReports, decisionOutstanding };
