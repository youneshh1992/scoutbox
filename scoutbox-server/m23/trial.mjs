/**
 * M23 P4B — the Trial engine: pure functions over the canonical `db.trials` row.
 *
 * A Trial row keeps its M12 meaning — AN ACCEPTED TRIAL — and its two-valued
 * `status` (the report obligation: `awaiting_report` | `reported`). Nothing in
 * this file reads `status` as a schedule and nothing writes it. The
 * operational truth P4B adds lives in its own fields, all additive
 * (M23_P4A_DECISION_REGISTER.md D-1, D-20):
 *
 *   caseId          the recruitment case this trial belongs to (null = legacy)
 *   workflowState   legacy_accepted | accepted | scheduled | completed | cancelled
 *   schedule        { timezone, revision, confirmedAt, confirmedBy, sessions[], revisions[] } | null
 *   attendance[]    append-only per-session records { sessionId, state, source, recordedBy, recordedAt, note }
 *   completion      { state: completed | cancelled, at, by, reason, phase } | null
 *   keys            idempotency keys with payload fingerprints, per action
 *   rev/revAt/revBy the trial's OWN concurrency revision (never the case's)
 *   history[]       append-only, ids/states/times only
 *   reminders       persisted markers read by the M12 sweep
 *
 * THE TRUTH MODEL THIS FILE ENFORCES (mandate §1)
 *
 *   invitation ≠ accepted ≠ scheduled ≠ attended ≠ completed ≠ assessment ≠ decision
 *
 * so: a row exists only after acceptance; `scheduled` needs a CONFIRMED
 * revision with at least one concrete session; `completed` needs recorded
 * attendance and an ended last session; cancellation is a completion state and
 * never `trial_completed`; nothing here reads an assessment or a Box Cam
 * result; nothing here writes a case status.
 *
 * Everything is deterministic and side-effect free (clock injected) so the
 * validators, the state derivation and the projections are property-testable
 * without Express or a database.
 */

import { parseTrialDate, isTrialDate } from '../domain.mjs';
import { validateIanaZone, parseInstant as parseCanonicalInstant, localParts as canonicalLocalParts } from '../temporal.mjs';
import { normaliseClientKey, payloadFingerprint } from './contact.mjs';

export const TRIAL_POLICY_VERSION = 1;

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));
const has = (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ vocabulary

/** The Trial's operational states (architecture §3). `legacy_accepted` is read-only interpretation of pre-P4B rows. */
export const TRIAL_WORKFLOW_STATES = Object.freeze(['legacy_accepted', 'accepted', 'scheduled', 'completed', 'cancelled']);
export const TRIAL_FINAL_STATES = Object.freeze(['completed', 'cancelled']);

export const TRIAL_WORKFLOW_LABELS = table({
  legacy_accepted: 'Accepted (no schedule recorded)',
  accepted: 'Accepted — schedule to be confirmed',
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
});

/** Contextual session kinds (Box Cam change classification N6). Minimal, closed. */
export const TRIAL_SESSION_KINDS = Object.freeze(['onboarding', 'training', 'drill', 'small_sided', 'match', 'other']);

/** Per-session attendance states (D-8). `not_recorded` is DERIVED, never stored. */
export const TRIAL_ATTENDANCE_STATES = Object.freeze(['attended', 'partial', 'no_show', 'club_cancelled', 'player_withdrew']);
export const TRIAL_ATTENDANCE_SOURCES = Object.freeze(['checkin', 'manual']);
/** The states that count as the player having taken part (D-5). */
export const TRIAL_ATTENDED_STATES = Object.freeze(['attended', 'partial']);

export const TRIAL_COMPLETION_STATES = Object.freeze(['completed', 'cancelled']);
export const TRIAL_CANCEL_ACTORS = Object.freeze(['club', 'player', 'guardian', 'system']);

export const TRIAL_LIMITS = Object.freeze({
  sessions: 20,
  slots: 3,
  instructions: 500,
  venueName: 120,
  venueTown: 80,
  venueAddress: 200,
  reason: 300,
  note: 300,
  message: 2000,
  clientKey: 64,
  evidencePerSession: 20,
  /** A session is at least 15 minutes and at most 12 hours. */
  minSessionMs: 15 * 60 * 1000,
  maxSessionMs: 12 * 60 * 60 * 1000,
  /** A schedule may not be revised more than this many times (a product bound, not a technical one). */
  revisions: 30,
  historyPage: 100,
});

/** A trial date, as a whole-day slot, is the D1 module's; instants are this module's. */
export const TRIAL_INSTANT_YEAR_MIN = 2000;
export const TRIAL_INSTANT_YEAR_MAX = 2100;

// ------------------------------------------------------------------ roles

/**
 * Who may do what (architecture §11). The same three levels are mirrored in
 * `roomCan` (m17/shared.mjs) so the Room keeps one permission surface.
 *
 *   trial_view    viewer and above — shared Trial information is club memory
 *   trial_assess  contributor and above — a scout may assess in Trial context
 *   trial_write   room lead and above — invite, schedule, cancel, attendance, complete, link
 */
const ROLE_RANK = table({ viewer: 0, contributor: 1, room_lead: 2, recruitment_admin: 3 });
const NEED = table({ trial_view: 0, trial_assess: 1, trial_write: 2 });
export function trialRoleAllows(role, action) {
  if (!has(NEED, action) || !has(ROLE_RANK, role)) return false;
  return ROLE_RANK[role] >= NEED[action];
}

// ------------------------------------------------------------------ keys

/** A client key, in the Trial vocabulary. Same rule as Contact, own error code. */
export function normaliseTrialClientKey(raw) {
  const k = normaliseClientKey(raw);
  if (k.ok) return k;
  return { ok: false, error: 'TRIAL_CLIENT_KEY_INVALID', message: k.message };
}
export { payloadFingerprint };

// ------------------------------------------------------------------ time

/**
 * An organiser timezone is an exact IANA name this runtime knows (D-21). No
 * case-folding, no alias resolution, no fallback to the server's zone: a
 * schedule whose zone is unknown is refused, never guessed. M23 P5.7: the
 * check itself is the platform's (`temporal.mjs`); this keeps the Trial code.
 */
export function validateTimezone(tz) {
  const v = validateIanaZone(tz);
  if (!v.ok) return { ok: false, error: 'TRIAL_TIMEZONE_INVALID', message: v.message };
  return { ok: true, timezone: v.timezone };
}

/**
 * The ONE parser for a Trial instant (mandate §46). Accepts an ISO 8601
 * date-time WITH an explicit offset or `Z`, or a finite integer millisecond
 * timestamp; anything else — a bare local time, a date-only string, a number
 * that is not an integer, text, an object — is refused. Returns UTC ms.
 * M23 P5.7: the parsing is the platform's; the year bound and code are Trial's.
 */
export function parseInstant(v) {
  const p = parseCanonicalInstant(v, { yearMin: TRIAL_INSTANT_YEAR_MIN, yearMax: TRIAL_INSTANT_YEAR_MAX });
  if (!p.ok) return { ok: false, error: 'TRIAL_SCHEDULE_INVALID', message: `A session time must be an ISO 8601 date-time with an explicit offset or Z, or a millisecond timestamp (${p.why}).` };
  return { ok: true, ms: p.ms };
}

/** Local wall-clock parts of an instant in a zone. Deterministic; Intl-backed. */
export const localParts = canonicalLocalParts;

/** `YYYY-MM-DD` of an instant in the organiser zone — the day the family sees. */
export function localDay(ms, timezone) {
  const p = localParts(ms, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** RFC 5545 local form `YYYYMMDDTHHMMSS` for `DTSTART;TZID=`. */
export function icsLocal(ms, timezone) {
  const p = localParts(ms, timezone);
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

/** RFC 5545 text escaping: backslash, semicolon, comma, line breaks. */
export const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// ------------------------------------------------------------------ text

/**
 * Shared text: bounded, one line where the field is a label, control
 * characters removed. Never HTML-interpreted anywhere (clients render text).
 */
function cleanText(raw, max, { oneLine = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (oneLine) s = s.replace(/[\r\n]+/g, ' ');
  s = s.trim();
  if (s.length > max) return { ok: false, tooLong: true };
  return { ok: true, value: s || null };
}

/** Venue for a session or an invitation: a name (required), a town, and (after acceptance only) an address. */
export function validateVenue(raw, { addressAllowed = true } = {}) {
  const bad = (message) => ({ ok: false, error: 'TRIAL_VENUE_INVALID', message });
  if (!isPlain(raw)) return bad('venue must be an object with at least a name.');
  const name = cleanText(raw.name, TRIAL_LIMITS.venueName, { oneLine: true });
  if (!name.ok || !name.value) return bad(name.tooLong ? `Keep the venue name under ${TRIAL_LIMITS.venueName} characters.` : 'A venue needs a name.');
  const town = cleanText(raw.town, TRIAL_LIMITS.venueTown, { oneLine: true });
  if (!town.ok) return bad(town.tooLong ? `Keep the town under ${TRIAL_LIMITS.venueTown} characters.` : 'The town must be text.');
  const address = cleanText(raw.address, TRIAL_LIMITS.venueAddress, { oneLine: true });
  if (!address.ok) return bad(address.tooLong ? `Keep the address under ${TRIAL_LIMITS.venueAddress} characters.` : 'The address must be text.');
  return { ok: true, venue: { name: name.value, town: town.value, address: addressAllowed ? address.value : null } };
}

// ------------------------------------------------------------------ sessions

const SESSION_SEQ = (id) => { const n = Number(String(id ?? '').split('-').pop()); return Number.isFinite(n) ? n : 0; };
/** Stable session order: start time, then the monotonic id part (mandate §68). */
export const byStartsAtThenId = (a, b) => (a.startsAt - b.startsAt) || (SESSION_SEQ(a.id) - SESSION_SEQ(b.id)) || String(a.id).localeCompare(String(b.id));

/**
 * Validate ONE session as a club proposes it. `id` is assigned by the caller
 * (stable, never array position). The venue on a session may carry an
 * address: it is shared with the routed recipient after acceptance (D-23).
 */
export function validateSessionInput(raw, { now = Date.now(), allowPast = false } = {}) {
  const bad = (message) => ({ ok: false, error: 'TRIAL_SCHEDULE_INVALID', message });
  if (!isPlain(raw)) return bad('Each session must be an object.');
  const kind = raw.kind === undefined || raw.kind === null ? 'training' : raw.kind;
  if (!TRIAL_SESSION_KINDS.includes(kind)) return { ok: false, error: 'TRIAL_SCHEDULE_INVALID', message: `Session kind must be one of ${TRIAL_SESSION_KINDS.join(', ')}.`, allowed: TRIAL_SESSION_KINDS };
  const start = parseInstant(raw.startsAt);
  if (!start.ok) return { ...start, field: 'startsAt' };
  const end = parseInstant(raw.endsAt);
  if (!end.ok) return { ...end, field: 'endsAt' };
  if (end.ms <= start.ms) return bad('A session must end after it starts.');
  const len = end.ms - start.ms;
  if (len < TRIAL_LIMITS.minSessionMs) return bad('A session is at least 15 minutes long.');
  if (len > TRIAL_LIMITS.maxSessionMs) return bad('A session is at most 12 hours long.');
  // A NEW session cannot be placed in the past. A session the trial already
  // has may have ended — a revision must carry it unchanged (the route checks
  // that), so it is not refused here (P4B defect D-P4B-2).
  if (!allowPast && end.ms <= now) return bad('A session cannot be scheduled entirely in the past.');
  const venue = validateVenue(raw.venue);
  if (!venue.ok) return venue;
  const instructions = cleanText(raw.instructions, TRIAL_LIMITS.instructions);
  if (!instructions.ok) return bad(instructions.tooLong ? `Keep the instructions under ${TRIAL_LIMITS.instructions} characters.` : 'Instructions must be text.');
  return { ok: true, session: { kind, startsAt: start.ms, endsAt: end.ms, venue: venue.venue, instructions: instructions.value } };
}

/**
 * Validate a whole schedule proposal: one organiser timezone, 1–20 sessions,
 * no overlaps (a player cannot be in two sessions at once — enforced here,
 * never client-only), stable order. Existing ids may be carried on a
 * revision; new sessions get ids from `mintId`.
 */
export function validateScheduleInput(raw, { now = Date.now(), mintId, existingIds = [] } = {}) {
  const bad = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });
  if (!isPlain(raw)) return bad('TRIAL_SCHEDULE_INVALID', 'A schedule is an object with a timezone and a list of sessions.');
  const tz = validateTimezone(raw.timezone);
  if (!tz.ok) return tz;
  if (!Array.isArray(raw.sessions)) return bad('TRIAL_SCHEDULE_INVALID', 'sessions must be a list.');
  if (raw.sessions.length === 0) return bad('TRIAL_SCHEDULE_INVALID', 'A schedule needs at least one session.');
  if (raw.sessions.length > TRIAL_LIMITS.sessions) return bad('TRIAL_SCHEDULE_INVALID', `A trial has at most ${TRIAL_LIMITS.sessions} sessions.`);
  const sessions = [];
  const seenIds = new Set();
  for (const s of raw.sessions) {
    const carried = typeof s?.id === 'string' && existingIds.includes(s.id);
    const v = validateSessionInput(s, { now, allowPast: carried });
    if (!v.ok) return v;
    let id = null;
    if (s.id !== undefined && s.id !== null && s.id !== '') {
      if (typeof s.id !== 'string' || !existingIds.includes(s.id)) return bad('TRIAL_SESSION_NOT_FOUND', 'A session id on a revision must name a session of this trial.');
      id = s.id;
    } else {
      id = mintId();
    }
    if (seenIds.has(id)) return bad('TRIAL_SCHEDULE_INVALID', 'A session id appears twice.');
    seenIds.add(id);
    sessions.push({ id, ...v.session });
  }
  sessions.sort(byStartsAtThenId);
  for (let i = 1; i < sessions.length; i += 1) {
    if (sessions[i].startsAt < sessions[i - 1].endsAt) return bad('TRIAL_SCHEDULE_INVALID', 'Sessions cannot overlap.');
  }
  return { ok: true, schedule: { timezone: tz.timezone, sessions } };
}

/**
 * Does a new revision change something the recipient agreed to (D-8, mandate
 * §50)? Material: the organiser timezone, the set of sessions, any session's
 * start or end, its venue name or town. Not material: instructions, the
 * venue address line, the session kind. A material change clears
 * `confirmedAt` and asks the recipient again.
 */
export function materialChange(prev, next) {
  if (!prev) return true;
  if (prev.timezone !== next.timezone) return true;
  if (prev.sessions.length !== next.sessions.length) return true;
  const key = (s) => `${s.id}|${s.startsAt}|${s.endsAt}|${s.venue?.name ?? ''}|${s.venue?.town ?? ''}`;
  const a = prev.sessions.map(key).sort(); const b = next.sessions.map(key).sort();
  return a.some((k, i) => k !== b[i]);
}

// ------------------------------------------------------------------ state

/** Is this a row written before P4B (no operational containers)? */
export const isLegacyTrial = (t) => !t || t.workflowState === undefined || t.workflowState === 'legacy_accepted';

/**
 * The operational state, DERIVED from the authoritative fields and compared
 * with the stored `workflowState`. The stored value is what routes assert on;
 * the derivation is what integrity checks it against, so the two can never
 * quietly disagree.
 */
export function deriveWorkflowState(t) {
  if (!t) return null;
  if (t.completion?.state === 'cancelled') return 'cancelled';
  if (t.completion?.state === 'completed') return 'completed';
  if (isLegacyTrial(t) && !t.schedule) return 'legacy_accepted';
  if (t.schedule?.confirmedAt && Array.isArray(t.schedule.sessions) && t.schedule.sessions.length > 0) return 'scheduled';
  return 'accepted';
}

/** Latest attendance record per session (append-only history → current map). */
export function currentAttendance(t) {
  const out = new Map();
  for (const a of t?.attendance ?? []) {
    if (!a || typeof a.sessionId !== 'string') continue;
    out.set(a.sessionId, a);
  }
  return out;
}

/** The session with the latest end time in the CURRENT revision. */
export const lastSession = (t) => (t?.schedule?.sessions ?? []).slice().sort((a, b) => b.endsAt - a.endsAt)[0] ?? null;

/**
 * THE completion gate (D-5, mandate §13). Every reason is returned so the
 * refusal says what is missing rather than "no".
 */
export function canComplete(t, { now = Date.now() } = {}) {
  const reasons = [];
  if (!t) return { ok: false, error: 'TRIAL_NOT_FOUND', message: 'No such trial.' };
  const state = deriveWorkflowState(t);
  if (state === 'cancelled') reasons.push('trial_cancelled');
  if (state === 'completed') reasons.push('already_completed');
  if (state !== 'scheduled' && state !== 'completed' && state !== 'cancelled') reasons.push('schedule_not_confirmed');
  const sessions = t.schedule?.sessions ?? [];
  const att = currentAttendance(t);
  const taken = sessions.some((s) => TRIAL_ATTENDED_STATES.includes(att.get(s.id)?.state));
  if (!taken) reasons.push('no_attended_session');
  const last = lastSession(t);
  if (!last || !(last.endsAt <= now)) reasons.push('last_session_not_ended');
  if (state === 'completed') {
    return { ok: false, error: 'TRIAL_INVALID_STATE', message: 'This trial is already completed.', reasons };
  }
  if (reasons.length) {
    return { ok: false, error: 'TRIAL_COMPLETION_REQUIREMENTS_NOT_MET', message: 'A trial completes only after a confirmed schedule, recorded attendance at a session, and the last session has ended.', reasons };
  }
  return { ok: true };
}

/**
 * Which club actions the Trial's state permits (independent of role, block or
 * case). Cancellation is possible from every open state; nothing is possible
 * from a final state except reading.
 */
export function trialStateAllows(t, action) {
  const state = deriveWorkflowState(t);
  const open = state === 'accepted' || state === 'scheduled' || state === 'legacy_accepted';
  switch (action) {
    case 'schedule': return open;
    case 'reschedule': return open && !!t.schedule;
    case 'cancel': return open;
    case 'attendance': return state === 'scheduled';
    case 'complete': return state === 'scheduled';
    case 'link': return state === 'scheduled' || state === 'completed';
    case 'confirm': return (state === 'accepted' || state === 'legacy_accepted') && !!t.schedule && !t.schedule.confirmedAt;
    default: return false;
  }
}

/**
 * Block policy (D-16, mandate §33). Once the player or guardian has blocked
 * the organisation, the club may only CANCEL an accepted trial (an
 * operational safety notice, not solicitation) and file the mandatory
 * report; the recipient may still decline, cancel or read. Everything else —
 * scheduling, rescheduling, attendance, completion, evidence, assessment —
 * is refused as `TRIAL_BLOCKED`.
 */
export const BLOCKED_CLUB_ACTIONS_ALLOWED = Object.freeze(['cancel', 'report']);
export const blockedAllows = (action) => BLOCKED_CLUB_ACTIONS_ALLOWED.includes(action);

// ------------------------------------------------------------------ integrity

/**
 * Structural soundness of a Trial row for the evidence provider and the
 * projections. A problem list, never a repair: a corrupt row is omitted and
 * counted, and never becomes evidence (architecture §4).
 */
export function trialIntegrity(t, { orgId = null, caseId = null } = {}) {
  try {
    return trialIntegrityUnsafe(t, { orgId, caseId });
  } catch {
    // A row so malformed that the checker itself cannot read it is exactly
    // the row the checker exists to name. Never a throw, never a 500.
    return ['unreadable'];
  }
}

function trialIntegrityUnsafe(t, { orgId = null, caseId = null } = {}) {
  const p = [];
  if (!isPlain(t)) return ['not_an_object'];
  if (typeof t.id !== 'string' || !t.id) p.push('id');
  if (typeof t.orgId !== 'string' || !t.orgId) p.push('orgId');
  if (typeof t.playerId !== 'string' || !t.playerId) p.push('playerId');
  if (orgId && t.orgId !== orgId) p.push('org_mismatch');
  if (caseId && t.caseId !== caseId) p.push('case_mismatch');
  if (!['awaiting_report', 'reported'].includes(t.status)) p.push('status');
  if (t.workflowState !== undefined && !TRIAL_WORKFLOW_STATES.includes(t.workflowState)) p.push('workflowState');
  if (t.workflowState !== undefined && t.workflowState !== deriveWorkflowState(t)) p.push('workflowState_mismatch');
  if (t.schedule !== undefined && t.schedule !== null) {
    const s = t.schedule;
    if (!isPlain(s)) p.push('schedule');
    else {
      if (!validateTimezone(s.timezone).ok) p.push('schedule.timezone');
      if (!Array.isArray(s.sessions)) p.push('schedule.sessions');
      else {
        const ids = new Set();
        for (const x of s.sessions) {
          if (!isPlain(x) || typeof x.id !== 'string' || ids.has(x.id)) { p.push('schedule.session'); break; }
          ids.add(x.id);
          if (!Number.isFinite(x.startsAt) || !Number.isFinite(x.endsAt) || x.endsAt <= x.startsAt) { p.push('schedule.session_time'); break; }
        }
        if (s.sessions.length > TRIAL_LIMITS.sessions) p.push('schedule.session_count');
      }
      if (s.confirmedAt !== null && s.confirmedAt !== undefined && !Number.isFinite(s.confirmedAt)) p.push('schedule.confirmedAt');
    }
  }
  if (t.attendance !== undefined) {
    if (!Array.isArray(t.attendance)) p.push('attendance');
    else {
      // D-P4B-4: a schedule whose `sessions` is not a list was already
      // flagged above; the attendance check must not throw over it.
      const ids = new Set((Array.isArray(t.schedule?.sessions) ? t.schedule.sessions : []).map((s) => s?.id));
      for (const a of t.attendance) {
        if (!isPlain(a) || !TRIAL_ATTENDANCE_STATES.includes(a.state) || !ids.has(a.sessionId)) { p.push('attendance.record'); break; }
      }
    }
  }
  if (t.completion !== undefined && t.completion !== null) {
    if (!isPlain(t.completion) || !TRIAL_COMPLETION_STATES.includes(t.completion.state) || !Number.isFinite(t.completion.at)) p.push('completion');
  }
  if (t.rev !== undefined && !(Number.isInteger(t.rev) && t.rev >= 1)) p.push('rev');
  return p;
}

// ------------------------------------------------------------------ projections

const HISTORY_SEQ = (id) => { const n = Number(String(id ?? '').split('-').pop()); return Number.isFinite(n) ? n : 0; };
export const byAtThenId = (a, b) => (a.at - b.at) || (HISTORY_SEQ(a.id) - HISTORY_SEQ(b.id));

/** A session as the club and (after acceptance) the family see it. Evidence is ids only. */
function sessionView(s, att, { withAddress, withInstructions, withEvidence }) {
  const a = att.get(s.id) ?? null;
  return {
    id: s.id, kind: s.kind, startsAt: s.startsAt, endsAt: s.endsAt,
    venue: s.venue ? { name: s.venue.name, town: s.venue.town ?? null, address: withAddress ? (s.venue.address ?? null) : undefined } : null,
    instructions: withInstructions ? (s.instructions ?? null) : undefined,
    attendance: a ? { state: a.state, source: a.source, recordedAt: a.recordedAt } : { state: 'not_recorded', source: null, recordedAt: null },
    evidence: withEvidence ? (s.evidence ?? []).map((e) => ({ id: e.id, kind: e.kind, sessionId: e.sessionId, linkedAt: e.linkedAt })) : undefined,
  };
}

/**
 * The current schedule for a viewer. Legacy rows carry a date-only,
 * timezone-less entry, flagged.
 *
 * The three viewers, and what each one is:
 *
 *   `club`             the organising club: everything operational, evidence included
 *   `family_accepted`  the player or guardian who accepted: the exact venue
 *                      address and the club's joining instructions, which were
 *                      held back from the invitation (P4B D-23)
 *   `agent`            M23 P5.6E: an authorised agent reading their client's
 *                      trial. Times, session kinds, the venue's NAME and town,
 *                      attendance. Not the address, not the instructions, not
 *                      the evidence list — those belong to the family and the
 *                      club, and an agent is neither.
 *
 * An unrecognised viewer gets the narrowest of the three, so a new caller that
 * forgets to name itself under-shares rather than over-shares.
 */
export const TRIAL_SCHEDULE_VIEWERS = Object.freeze(['club', 'family_accepted', 'agent']);

export function scheduleView(t, viewer) {
  const att = currentAttendance(t);
  if (!t.schedule) {
    if (isTrialDate(t.proposedDate)) return { legacy: true, timezone: null, revision: 0, confirmedAt: null, date: t.proposedDate, sessions: [] };
    return null;
  }
  const club = viewer === 'club';
  return {
    legacy: false,
    timezone: t.schedule.timezone,
    revision: t.schedule.revision,
    confirmedAt: t.schedule.confirmedAt ?? null,
    confirmedBy: t.schedule.confirmedBy ? { kind: t.schedule.confirmedBy.kind } : null,
    proposedAt: t.schedule.proposedAt ?? null,
    awaitingConfirmation: !t.schedule.confirmedAt,
    sessions: t.schedule.sessions.slice().sort(byStartsAtThenId).map((s) => sessionView(s, att, {
      withAddress: club || viewer === 'family_accepted',
      withInstructions: club || viewer === 'family_accepted',
      withEvidence: club,
    })),
  };
}

/** Club-side view: everything operational, never the family's emergency contact, never a Box Cam payload. */
export function trialClubView(t) {
  const state = deriveWorkflowState(t);
  return {
    id: t.id, caseId: t.caseId ?? null, requestId: t.requestId ?? null,
    playerId: t.playerId, playerName: t.playerName ?? null, orgId: t.orgId,
    workflowState: state, workflowLabel: TRIAL_WORKFLOW_LABELS[state] ?? state,
    legacy: isLegacyTrial(t),
    reportStatus: t.status, reportDueAt: Number.isFinite(t.reportDueAt) ? t.reportDueAt : null, hasReport: !!t.report,
    acceptedAt: t.acceptedAt ?? null, acceptedBy: t.acceptedBy ?? null, guardianApproved: t.guardianApproved ?? null,
    proposedDate: t.proposedDate ?? null, venue: t.venue ?? null,
    schedule: scheduleView(t, 'club'),
    revisions: (t.schedule?.revisions ?? []).map((r) => ({ revision: r.revision, proposedAt: r.proposedAt, proposedBy: r.proposedBy ? { kind: r.proposedBy.kind, name: r.proposedBy.name ?? null } : null, confirmedAt: r.confirmedAt ?? null, supersededAt: r.supersededAt ?? null, reason: r.reason ?? null, material: r.material ?? null, sessionCount: r.sessions?.length ?? 0 })),
    attendanceHistory: (t.attendance ?? []).map((a) => ({ sessionId: a.sessionId, state: a.state, source: a.source, recordedAt: a.recordedAt, recordedBy: a.recordedBy ? { name: a.recordedBy.name ?? null } : null, note: a.note ?? null })),
    completion: t.completion ? { state: t.completion.state, at: t.completion.at, by: t.completion.by ? { kind: t.completion.by.kind, name: t.completion.by.name ?? null } : null, reason: t.completion.reason ?? null, phase: t.completion.phase ?? null, cancelledBy: t.completion.cancelledBy ?? null } : null,
    recipient: t.recipient ? { type: t.recipient.type, minor: !!t.recipient.minor } : null,
    blockedBy: t.blockedBy ?? null,
    subjectRemovedAt: t.subjectRemovedAt ?? null,
    evidenceCount: (t.schedule?.sessions ?? []).reduce((n, s) => n + (s.evidence ?? []).filter((e) => !e.removedAt).length, 0),
    history: (t.history ?? []).slice().sort(byAtThenId).map((h) => ({ id: h.id, at: h.at, action: h.action, by: h.by ? { kind: h.by.kind ?? null, name: h.by.name ?? null } : null, detail: h.detail ?? null })),
    rev: t.rev ?? 1, revAt: t.revAt ?? null,
    policyVersion: TRIAL_POLICY_VERSION,
  };
}

/**
 * Family view (player or guardian): the shared operational edge and nothing
 * else — no caseId, no history internals, no evidence, no assessment. The
 * exact venue address and instructions are shared once accepted (D-23) —
 * a Trial row exists only after acceptance, so here they always are.
 */
export function trialFamilyView(t) {
  const state = deriveWorkflowState(t);
  return {
    id: t.id, orgId: t.orgId, orgName: t.orgName ?? null, playerId: t.playerId,
    workflowState: state, workflowLabel: TRIAL_WORKFLOW_LABELS[state] ?? state,
    legacy: isLegacyTrial(t),
    acceptedAt: t.acceptedAt ?? null,
    proposedDate: t.proposedDate ?? null, venue: t.venue ?? null,
    schedule: scheduleView(t, 'family_accepted'),
    awaitingYourConfirmation: !!t.schedule && !t.schedule.confirmedAt,
    completion: t.completion ? { state: t.completion.state, at: t.completion.at, byKind: t.completion.by?.kind ?? null, reason: t.completion.state === 'cancelled' ? (t.completion.reason ?? null) : null } : null,
    reportStatus: t.status, hasReport: !!t.report,
    rev: t.rev ?? 1,
  };
}

/** The journey milestone: ids, states, times, counts. Never text. */
export function trialMilestone(t) {
  const att = currentAttendance(t);
  const sessions = t.schedule?.sessions ?? [];
  return {
    id: t.id, caseId: t.caseId ?? null, requestId: t.requestId ?? null,
    workflowState: deriveWorkflowState(t), legacy: isLegacyTrial(t),
    reportStatus: t.status, hasReport: !!t.report,
    acceptedAt: t.acceptedAt ?? null,
    scheduledAt: t.schedule?.confirmedAt ?? null,
    revision: t.schedule?.revision ?? 0,
    sessions: sessions.slice().sort(byStartsAtThenId).map((s) => ({ id: s.id, kind: s.kind, startsAt: s.startsAt, endsAt: s.endsAt, attendance: att.get(s.id)?.state ?? 'not_recorded', evidenceCount: (s.evidence ?? []).filter((e) => !e.removedAt).length })),
    completion: t.completion ? { state: t.completion.state, at: t.completion.at, byKind: t.completion.by?.kind ?? null } : null,
    evidenceCount: sessions.reduce((n, s) => n + (s.evidence ?? []).filter((e) => !e.removedAt).length, 0),
  };
}

/** The outcome line a minor's own device may show: state only (privacy matrix). */
export function trialOutcomeLine(t) {
  const state = deriveWorkflowState(t);
  return { id: t.id, orgName: t.orgName ?? null, workflowState: state, workflowLabel: TRIAL_WORKFLOW_LABELS[state] ?? state, guardianManaged: true };
}
