// M23 P4B acceptance suite — the Trial workflow.
//
// The governing principle this suite exists to enforce (mandate §5–§9):
//
//   An invitation is not an acceptance; an acceptance is not a schedule; a
//   schedule is not attendance; attendance is not completion; completion is
//   not an assessment; an assessment is not a decision. Box Cam observation
//   is machine evidence, never an assessment; a refusal means no reliable
//   observation is available, never poor performance.
//
// Groups:
//   U  pure engine — timezones, instants, schedules, states, gates, views, tables
//   P  policy — error bands, rate policies, event registry, migration, evidence, roomCan
//   J  the adult journey over HTTP, the case advancing only through evidence
//   V  the recipient's own view at every step; what never crosses the edge
//   S  schedule semantics — revisions, material change, ended sessions, limits
//   A  attendance and the completion gate
//   M  the minor journey — guardian route, child's device, revoked guardian
//   W  the walls — agency, unverified club, foreign organisation, roles
//   B  blocks — before, pending, scheduled; D-16 nuanced policy
//   K  expectedRev matrix, idempotency, cross-org keys
//   C  the concurrency matrix
//   F  honest transport failure — invitation, acceptance, completion
//   E  Box Cam evidence by reference — N1..N6, refusal copy, withdrawn, unlink
//   Q  assessments in Trial context — blind rule, single door, immutability
//   I  sentinels across every recipient-facing surface
//   N  notifications, audit and journey milestones
//   X  content — XSS, prototype keys, input types, limits, ICS escaping
//   T  the subject removed their account — tombstones
//   Z  restart — keys, links and truth survive the process dying
//
// No assertion here is `status !== 200`. Every refusal names the status and
// the code it expects.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRIAL_WORKFLOW_STATES, TRIAL_SESSION_KINDS, TRIAL_ATTENDANCE_STATES, TRIAL_LIMITS, TRIAL_WORKFLOW_LABELS,
  validateTimezone, parseInstant, localDay, icsLocal, icsText, validateVenue, validateSessionInput, validateScheduleInput,
  materialChange, deriveWorkflowState, isLegacyTrial, currentAttendance, canComplete, trialStateAllows, blockedAllows,
  trialIntegrity, trialClubView, trialFamilyView, trialMilestone, trialOutcomeLine, normaliseTrialClientKey, trialRoleAllows,
} from '../m23/trial.mjs';
import { M23_ERROR_HTTP, httpStatusFor } from '../m23/errors.mjs';
import { EVENT_REGISTRY } from '../m182/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../m182/migrations.mjs';
import { STATUS_EVIDENCE_REQUIRED, roomCan } from '../m17/shared.mjs';
import { createEvidenceProvider, EVIDENCE_KINDS } from '../m23/evidence.mjs';

const PORT = 6100 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };
const S_ASSESS = 'PRIVATE_TRIAL_ASSESSMENT_SENTINEL_9481';
const S_NOTE = 'PRIVATE_TRIAL_NOTE_SENTINEL_5284';
const S_EMERG = 'PRIVATE_EMERGENCY_SENTINEL_7713';
const H = 3_600_000; const MIN = 60_000;

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Exact status AND exact code. */
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`);
  return good;
};
const has = (o, s) => JSON.stringify(o ?? null).includes(s);

// ============================================================ U — pure engine
section('U — timezones and instants: exact IANA, calendar-valid, one clock');
{
  ok(validateTimezone('Europe/London').ok && validateTimezone('UTC').ok && validateTimezone('Asia/Kolkata').ok && validateTimezone('Europe/Kyiv').ok && validateTimezone('America/St_Johns').ok, 'U1 exact IANA identifiers are accepted — including current names an older ICU still reports under a legacy alias (D-P4B-1)');
  neg(validateTimezone('asia/kolkata').ok === false && validateTimezone('Asia/kolkata').ok === false && validateTimezone('europe/kyiv').ok === false, 'U1b the modern-name path folds no case either');
  for (const bad of ['europe/london', 'Europe/london', 'Mars/Olympus', 'GMT+1', 'BST', 'Z', '', ' UTC', 'UTC ', null, undefined, 42, {}, [], 'constructor', '__proto__', 'hasOwnProperty']) {
    const v = validateTimezone(bad);
    neg(v.ok === false && v.error === 'TRIAL_TIMEZONE_INVALID', `U2 "${String(bad)}" is not a timezone (exact match, no case folding, no offsets)`);
  }
  ok(parseInstant('2026-11-02T09:30:00Z').ok && parseInstant('2026-11-02T09:30:00+01:00').ok && parseInstant(1_800_000_000_000).ok, 'U3 ISO with Z or an offset, or integer milliseconds, are instants');
  for (const bad of ['2026-11-02T09:30:00', '2026-11-02', '2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-04-31T10:00:00Z', 'tomorrow', '', null, 1.5, '1800000000000', -1, NaN, Infinity, {}, [], true, '1999-12-31T23:59:59Z', '2101-01-01T00:00:00Z', '2026-11-02T24:00:00Z', '2026-11-02T09:60:00Z']) {
    const v = parseInstant(bad);
    neg(v.ok === false, `U4 ${JSON.stringify(bad)} is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only`);
  }
  // Leap day and DST: the organiser's local day is what the family sees.
  ok(parseInstant('2028-02-29T10:00:00Z').ok, 'U5 29 February 2028 is a real day');
  neg(parseInstant('2027-02-29T10:00:00Z').ok === false, 'U5b 29 February 2027 is not');
  const dst = parseInstant('2026-03-29T00:30:00Z').ms; // 00:30 UTC = 00:30 GMT, before the 01:00 UTC spring-forward
  ok(localDay(dst, 'Europe/London') === '2026-03-29' && localDay(dst + 2 * H, 'Europe/London') === '2026-03-29', 'U6 the spring-forward instant keeps its London day on both sides of the gap');
  ok(localDay(parseInstant('2026-11-02T23:30:00Z').ms, 'Asia/Kolkata') === '2026-11-03' && localDay(parseInstant('2026-11-02T23:30:00Z').ms, 'America/Los_Angeles') === '2026-11-02', 'U7 the same instant is a different calendar day in different zones — never a bare date');
  ok(icsLocal(parseInstant('2026-07-01T09:00:00Z').ms, 'Europe/London') === '20260701T100000', 'U8 ICS local form is wall-clock in the organiser zone (BST +1)');
  ok(icsText('a;b,c\\d\nline') === 'a\\;b\\,c\\\\d\\nline', 'U9 ICS text escaping covers ; , backslash and line breaks');
}

section('U — schedules: bounds, overlap, stable ids, material change');
{
  const NOW = parseInstant('2026-10-01T12:00:00Z').ms;
  let seq = 0; const mint = () => `tses-${++seq}`;
  const venue = { name: 'Dome', town: 'Eastport' };
  const s = (h1, h2, extra = {}) => ({ startsAt: NOW + h1 * H, endsAt: NOW + h2 * H, venue, ...extra });
  const good = validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 4), s(26, 28, { kind: 'match' })] }, { now: NOW, mintId: mint });
  ok(good.ok && good.schedule.sessions.length === 2 && good.schedule.sessions[0].id === 'tses-1' && good.schedule.sessions[1].kind === 'match' && good.schedule.sessions[0].kind === 'training', 'U10 a valid schedule mints stable ids and defaults the kind to training');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [] }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID', 'U11 zero sessions is not a schedule');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: Array.from({ length: 21 }, (_, i) => s(2 + i * 24, 4 + i * 24)) }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID', 'U12 twenty-one sessions is over the limit');
  ok(validateScheduleInput({ timezone: 'Europe/London', sessions: Array.from({ length: 20 }, (_, i) => s(2 + i * 24, 4 + i * 24)) }, { now: NOW, mintId: mint }).ok, 'U12b twenty is the limit, inclusive');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 4), s(3, 5)] }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID', 'U13 overlapping sessions are refused server-side');
  ok(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 4), s(4, 6)] }, { now: NOW, mintId: mint }).ok, 'U13b back-to-back sessions (end == next start) do not overlap');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 2.2)] }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID', 'U14 a 12-minute session is under the 15-minute minimum');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 14.5)] }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID', 'U14b a 12.5-hour session is over the 12-hour maximum');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(-5, -3)] }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID', 'U15 a session entirely in the past is refused');
  ok(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(-0.5, 0.5)] }, { now: NOW, mintId: mint }).ok, 'U15b a session already under way (ends in the future) is allowed — it is happening');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(4, 2)] }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID', 'U16 end before start is refused');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 4, { kind: 'sparring' })] }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID', 'U17 an unknown session kind is refused');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 4, { id: 'tses-999' })] }, { now: NOW, mintId: mint, existingIds: ['tses-1'] }).error === 'TRIAL_SESSION_NOT_FOUND', 'U18 a revision naming a session id the trial never had is refused');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 4, { id: 'tses-1' }), s(26, 28, { id: 'tses-1' })] }, { now: NOW, mintId: mint, existingIds: ['tses-1'] }).error === 'TRIAL_SCHEDULE_INVALID', 'U19 the same session id twice is refused');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 4, { id: 7 })] }, { now: NOW, mintId: mint, existingIds: ['tses-1'] }).ok === false, 'U19b a numeric session id is not coerced into a string id');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: [{ ...s(2, 4), venue: 'Dome' }] }, { now: NOW, mintId: mint }).ok === false, 'U20 a venue must be an object with a name, not a bare string');
  neg(validateVenue({ name: 'x'.repeat(TRIAL_LIMITS.venueName + 1), town: 'T' }).ok === false && validateVenue({ name: '', town: 'T' }).ok === false && validateVenue(null).ok === false, 'U20b venue name bounds and presence are enforced');
  neg(validateScheduleInput({ timezone: 'Europe/London', sessions: 'lots' }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID' && validateScheduleInput('x', { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID' && validateScheduleInput({ timezone: 'Europe/London', sessions: [null] }, { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID', 'U21 wrong input types are refused, never iterated as if they were lists');
  neg(validateSessionInput({ ...s(2, 4), instructions: 'x'.repeat(TRIAL_LIMITS.instructions + 1) }, { now: NOW }).ok === false && validateSessionInput({ ...s(2, 4), instructions: 12 }, { now: NOW }).ok === false, 'U22 instructions are bounded text');
  const prev = { timezone: 'Europe/London', sessions: [{ id: 'a', startsAt: 1, endsAt: 2, venue: { name: 'Dome', town: 'E' } }] };
  neg(materialChange(prev, { timezone: 'Europe/Paris', sessions: prev.sessions }) === true, 'U23 a timezone change is material');
  neg(materialChange(prev, { timezone: 'Europe/London', sessions: [{ ...prev.sessions[0], startsAt: 3, endsAt: 4 }] }) === true, 'U23b a time change is material');
  neg(materialChange(prev, { timezone: 'Europe/London', sessions: [{ ...prev.sessions[0], venue: { name: 'Arena', town: 'E' } }] }) === true, 'U23c a venue name change is material');
  ok(materialChange(prev, { timezone: 'Europe/London', sessions: [{ ...prev.sessions[0], instructions: 'Bring boots', venue: { name: 'Dome', town: 'E', address: '1 Road' }, kind: 'match' }] }) === false, 'U23d instructions, the address line and the kind are not material — the confirmation stands');
  ok(materialChange(null, prev) === true, 'U23e the first schedule is always material');
}

section('U — states, gates and views');
{
  ok(Object.isFrozen(TRIAL_WORKFLOW_STATES) && TRIAL_WORKFLOW_STATES.join(',') === 'legacy_accepted,accepted,scheduled,completed,cancelled', 'U30 five workflow states, frozen');
  neg(TRIAL_WORKFLOW_STATES.every((s) => !['awaiting_report', 'reported', 'trial_requested', 'trial_scheduled', 'trial_completed'].includes(s)), 'U31 no workflow state is a report status or a case status — three vocabularies, no shared word');
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    neg(TRIAL_WORKFLOW_LABELS[key] === undefined, `U32 "${key}" is not a workflow label (null prototype)`);
  }
  const legacy = { id: 't', orgId: 'o', playerId: 'p', status: 'awaiting_report' };
  ok(isLegacyTrial(legacy) && deriveWorkflowState(legacy) === 'legacy_accepted' && deriveWorkflowState({ ...legacy, workflowState: 'legacy_accepted' }) === 'legacy_accepted', 'U33 a pre-P4B row derives legacy_accepted from the absence of containers');
  const acc = { ...legacy, workflowState: 'accepted', schedule: null, attendance: [], completion: null };
  ok(deriveWorkflowState(acc) === 'accepted', 'U34 accepted without a schedule');
  const proposed = { ...acc, schedule: { confirmedAt: null, sessions: [{ id: 's1', startsAt: 10, endsAt: 20 }], revision: 1, revisions: [] } };
  neg(deriveWorkflowState(proposed) === 'accepted', 'U35 a PROPOSED schedule is not scheduled — the recipient has not confirmed');
  const sched = { ...proposed, schedule: { ...proposed.schedule, confirmedAt: 5 }, workflowState: 'scheduled' };
  ok(deriveWorkflowState(sched) === 'scheduled', 'U36 a confirmed schedule with a session is scheduled');
  neg(deriveWorkflowState({ ...sched, schedule: { ...sched.schedule, sessions: [] } }) === 'accepted', 'U36b a confirmed schedule with no sessions is not scheduled');
  ok(deriveWorkflowState({ ...sched, completion: { state: 'cancelled', at: 1 } }) === 'cancelled' && deriveWorkflowState({ ...sched, completion: { state: 'completed', at: 1 } }) === 'completed', 'U37 completion.state wins over everything');
  neg(canComplete(acc, { now: 100 }).reasons.join(',') === 'schedule_not_confirmed,no_attended_session,last_session_not_ended', 'U38 completing an accepted trial names all three missing requirements');
  neg(canComplete(sched, { now: 100 }).reasons.join(',') === 'no_attended_session', 'U39 a scheduled trial after its last session but without attendance is not completable');
  neg(canComplete({ ...sched, attendance: [{ sessionId: 's1', state: 'no_show' }] }, { now: 100 }).reasons.join(',') === 'no_attended_session', 'U39b a no-show is attendance recorded, but not attendance taken');
  neg(canComplete({ ...sched, attendance: [{ sessionId: 's1', state: 'attended' }] }, { now: 15 }).reasons.join(',') === 'last_session_not_ended', 'U40 attended, but the last session is still running');
  ok(canComplete({ ...sched, attendance: [{ sessionId: 's1', state: 'partial' }] }, { now: 20 }).ok === true, 'U41 partial attendance and the last session ended (end == now) completes');
  neg(canComplete({ ...sched, attendance: [{ sessionId: 's1', state: 'no_show' }, { sessionId: 's1', state: 'attended' }] }, { now: 20 }).ok === true && canComplete({ ...sched, attendance: [{ sessionId: 's1', state: 'attended' }, { sessionId: 's1', state: 'no_show' }] }, { now: 20 }).ok === false, 'U42 attendance is append-only and the LAST record is current');
  neg(canComplete({ ...sched, completion: { state: 'completed' } }, { now: 20 }).error === 'TRIAL_INVALID_STATE' && canComplete({ ...sched, completion: { state: 'cancelled' } }, { now: 20 }).reasons.includes('trial_cancelled'), 'U43 a completed trial is not completed twice; a cancelled one is not completed at all');
  const M = (t, actions) => actions.map((a) => trialStateAllows(t, a) ? 1 : 0).join('');
  const ACTS = ['schedule', 'reschedule', 'cancel', 'attendance', 'complete', 'link', 'confirm'];
  ok(M(acc, ACTS) === '1010000' && M(proposed, ACTS) === '1110001' && M(sched, ACTS) === '1111110', 'U44 the state × action matrix: accepted/proposed/scheduled');
  neg(M({ ...sched, completion: { state: 'completed' } }, ACTS) === '0000010' && M({ ...sched, completion: { state: 'cancelled' } }, ACTS) === '0000000', 'U45 completed allows only evidence linking; cancelled allows nothing');
  neg(trialStateAllows(sched, 'assess') === false && trialStateAllows(sched, 'constructor') === false, 'U46 an unknown action is never allowed');
  ok(blockedAllows('cancel') && blockedAllows('report'), 'U47 a blocked club may cancel and file the mandatory report');
  neg(['schedule', 'reschedule', 'attendance', 'complete', 'link', 'invite', 'assess'].every((a) => blockedAllows(a) === false), 'U47b and may do nothing else (D-16)');
  ok(trialRoleAllows('recruitment_admin', 'trial_write') && trialRoleAllows('room_lead', 'trial_write') && trialRoleAllows('contributor', 'trial_assess') && trialRoleAllows('viewer', 'trial_view'), 'U48 write is lead+, assess is member+, view is everyone in the room');
  neg(!trialRoleAllows('contributor', 'trial_write') && !trialRoleAllows('viewer', 'trial_assess') && !trialRoleAllows(null, 'trial_view') && !trialRoleAllows('admin', 'trial_view'), 'U48b a contributor cannot write, a viewer cannot assess, no role is no access');
  ok(roomCan('contributor', 'trial_assess') && !roomCan('contributor', 'trial_write') && roomCan('room_lead', 'trial_write'), 'U49 roomCan carries the same three actions (one permission table)');
  const corrupt = [
    [{ ...sched, orgId: 'other' }, 'org_mismatch'], [{ ...sched, workflowState: 'accepted' }, 'state_mismatch'], [{ ...sched, workflowState: 'flying' }, 'state_unknown'],
    [{ ...sched, attendance: 'yes' }, 'attendance_not_list'], [{ ...sched, schedule: { ...sched.schedule, sessions: [{ id: 's1', startsAt: 20, endsAt: 10 }] } }, 'session_time'],
    [{ ...sched, attendance: [{ sessionId: 'ghost', state: 'attended' }] }, 'attendance_orphan'], [{ ...sched, completion: { state: 'done' } }, 'completion_state'],
    [{ ...sched, schedule: { ...sched.schedule, timezone: 'Mars/Olympus' } }, 'timezone'], [{ ...sched, caseId: 'k2' }, 'case_mismatch'],
  ];
  for (const [row, what] of corrupt) neg(trialIntegrity(row, { orgId: 'o', caseId: 'k1' }).length > 0, `U50 a corrupt row (${what}) fails integrity instead of being served`);
  ok(trialIntegrity({ ...sched, caseId: 'k1', schedule: { ...sched.schedule, timezone: 'Europe/London' } }, { orgId: 'o', caseId: 'k1' }).length === 0, 'U50b a sound row passes');
  const full = {
    ...sched, caseId: 'k1', playerName: 'P', orgName: 'O', acceptedAt: 1, proposedDate: '2026-10-01', venue: 'Dome',
    schedule: { ...sched.schedule, timezone: 'Europe/London', sessions: [{ id: 's1', startsAt: 10, endsAt: 20, kind: 'training', venue: { name: 'Dome', town: 'E', address: 'Gate B' }, instructions: 'Ask for Priya', evidence: [{ id: 'e1', kind: 'box_cam_session', sessionId: 'bx1', linkedAt: 1 }] }] },
    attendance: [{ sessionId: 's1', state: 'attended', source: 'manual', recordedAt: 12, recordedBy: { kind: 'org', userId: 'u1', name: 'Maria' }, note: S_NOTE }],
    history: [{ id: 'aud-1', at: 1, action: 'trial_accepted', by: { kind: 'player', id: 'p', name: 'Kola' }, detail: { day: '2026-10-01' } }],
    recipient: { type: 'player', playerId: 'p', guardianId: null, minor: false }, keys: { accept: { key: 'secret-key', fp: 'x' } },
    day: { emergency: { name: S_EMERG, phone: '0777' }, staff: [] }, rev: 3,
  };
  const cv = trialClubView(full); const fv = trialFamilyView(full); const mv = trialMilestone(full); const ov = trialOutcomeLine(full);
  ok(cv.workflowState === 'scheduled' && cv.rev === 3 && cv.caseId === 'k1' && cv.schedule.sessions[0].instructions === 'Ask for Priya' && cv.attendanceHistory[0].note === S_NOTE, 'U51 the club view carries the operational record, including the club\'s own note');
  neg(!has(cv, S_EMERG) && !has(cv, 'secret-key') && !has(cv, '0777'), 'U52 the club view never carries the family\'s emergency contact or an idempotency key');
  neg(!has(fv, 'k1') && !has(fv, S_NOTE) && !has(fv, 'bx1') && !has(fv, 'aud-1') && fv.caseId === undefined && fv.history === undefined && fv.attendanceHistory === undefined, 'U53 the family view has no case id, no club note, no evidence link and no history internals');
  ok(fv.schedule.sessions[0].venue.address === 'Gate B' && fv.schedule.sessions[0].instructions === 'Ask for Priya' && fv.awaitingYourConfirmation === false, 'U53b the family view shares the address and instructions (accepted trial, D-23)');
  neg(!has(mv, 'Ask for Priya') && !has(mv, 'Gate B') && !has(mv, S_NOTE) && mv.sessions[0].attendance === 'attended' && mv.sessions[0].evidenceCount === 1, 'U54 the milestone is ids, states, times and counts — never text');
  neg(Object.keys(ov).sort().join(',') === 'guardianManaged,id,orgName,workflowLabel,workflowState', 'U55 the minor\'s outcome line is exactly five fields');
  ok(normaliseTrialClientKey(undefined).ok && normaliseTrialClientKey(undefined).key === null && normaliseTrialClientKey('k-1').key === 'k-1', 'U56 a client key is optional');
  neg(normaliseTrialClientKey('x'.repeat(TRIAL_LIMITS.clientKey + 1)).error === 'TRIAL_CLIENT_KEY_INVALID' && normaliseTrialClientKey(12).error === 'TRIAL_CLIENT_KEY_INVALID' && normaliseTrialClientKey({}).error === 'TRIAL_CLIENT_KEY_INVALID' && normaliseTrialClientKey([]).error === 'TRIAL_CLIENT_KEY_INVALID', 'U56b too long, numeric, object or list keys are refused (an empty string is simply no key)');
}

// ================================================================ P — policy
section('P — error bands, rate policies, events, migration, evidence, permissions');
{
  const TRIAL_CODES = Object.keys(M23_ERROR_HTTP).filter((c) => c.startsWith('TRIAL_'));
  ok(TRIAL_CODES.length >= 24, `P1 ${TRIAL_CODES.length} TRIAL_* codes carry an HTTP band`);
  ok(httpStatusFor('TRIAL_REV_REQUIRED') === 400 && httpStatusFor('TRIAL_NOT_PERMITTED') === 403 && httpStatusFor('TRIAL_NOT_FOUND') === 404 && httpStatusFor('TRIAL_VERSION_CONFLICT') === 409 && httpStatusFor('TRIAL_GUARDIAN_REQUIRED') === 422 && httpStatusFor('TRIAL_INVITE_COOLDOWN') === 429 && httpStatusFor('TRIAL_TRANSPORT_REFUSED') === 500, 'P2 the bands: 400 input, 403 permission, 404 absence, 409 state, 422 recipient, 429 cooldown, 500 transport');
  neg(TRIAL_CODES.every((c) => [400, 403, 404, 409, 422, 429, 500].includes(M23_ERROR_HTTP[c])), 'P2b no TRIAL code lands outside the declared bands');
  for (const a of ['trial_invite', 'trial_schedule', 'trial_response', 'trial_evidence_link', 'trial_attendance']) ok(RATE_LIMIT_POLICY[a]?.max > 0 && RATE_LIMIT_POLICY[a].windowMs > 0, `P3 rate policy ${a} (${RATE_LIMIT_POLICY[a]?.max}/window, ${RATE_LIMIT_POLICY[a]?.scope})`);
  ok(RATE_LIMIT_POLICY.trial_response.scope === 'actor' && RATE_LIMIT_POLICY.trial_invite.scope === 'org', 'P3b responses are limited per actor; invitations per organisation');
  const EVENTS = ['trial_invited', 'trial_accepted', 'trial_declined', 'trial_scheduled', 'trial_rescheduled', 'trial_cancelled', 'trial_attendance_recorded', 'trial_completed', 'trial_evidence_linked'];
  for (const e of EVENTS) {
    const r = EVENT_REGISTRY[e];
    ok(!!r && r.audience === 'org_private' && r.privacyClass === 'org_internal' && r.replayPolicy === 'never' && r.analyticsEligible === false, `P4 event ${e} is registered org_private / org_internal, never replayed, never analytics`);
    neg(!!r && Array.isArray(r.payload) && r.payload.every((k) => /Id$/.test(k)) && !r.payload.some((k) => /name|note|message|reason|address|instruction/i.test(k)), `P4b ${e} payload is ids only`);
  }
  neg(EVENT_REGISTRY.trial_assessment_recorded === undefined && EVENT_REGISTRY.trial_observed === undefined, 'P5 no event announces an assessment or an observation — judgement never broadcasts');
  const step = MIGRATIONS.find((m) => m.id === 'm230_005_trial_workflow');
  ok(step?.version === 2304 && SCHEMA_VERSION === 2304, 'P6 migration m230_005_trial_workflow is version 2304 and is the current schema');
  const old = { schema: { version: 2303, migrations: MIGRATIONS.filter((m) => m.version <= 2303).map((m) => ({ id: m.id, version: m.version, at: 1 })) }, trials: [{ id: 't1', orgId: 'o', playerId: 'p', status: 'reported', proposedDate: '2025-05-01', acceptedAt: 1, report: { id: 'r' } }, { id: 't2', orgId: 'o', playerId: 'p', status: 'awaiting_report', workflowState: 'scheduled', schedule: { confirmedAt: 1, sessions: [{ id: 's', startsAt: 1, endsAt: 2 }] }, attendance: [], completion: null, rev: 4 }] };
  const up = runMigrations(old);
  ok(up.ran.includes('m230_005_trial_workflow') && old.trials[0].workflowState === 'legacy_accepted' && old.trials[0].schedule === null && Array.isArray(old.trials[0].attendance) && old.trials[0].completion === null && old.trials[0].rev === 1 && Array.isArray(old.trials[0].history) && old.trials[0].keys && old.trials[0].reminders, 'P7 a 2303 row gains neutral containers and legacy_accepted; status and report untouched');
  neg(old.trials[0].status === 'reported' && old.trials[0].report.id === 'r' && old.trials[0].proposedDate === '2025-05-01', 'P7b awaiting_report/reported are never renamed; no date, attendance or completion is invented');
  neg(old.trials[1].workflowState === 'scheduled' && old.trials[1].rev === 4 && old.trials[1].schedule.confirmedAt === 1, 'P7c a row that already carries P4B fields is left exactly as it was');
  const again = runMigrations(old);
  ok(again.ran.length === 0 && old.trials[0].workflowState === 'legacy_accepted', 'P8 running the migration twice changes nothing');
  ok(STATUS_EVIDENCE_REQUIRED.trial_requested?.kind === 'trial_invited' && STATUS_EVIDENCE_REQUIRED.trial_scheduled?.kind === 'trial_confirmed' && STATUS_EVIDENCE_REQUIRED.trial_completed?.kind === 'trial_completed', 'P9 the three trial stages are evidence-gated: invited, confirmed, completed (D-3/D-4/D-5)');
  ok(EVIDENCE_KINDS.includes('trial_invited') && EVIDENCE_KINDS.includes('trial_confirmed') && EVIDENCE_KINDS.includes('trial_completed'), 'P9b the evidence provider knows all three kinds');
  const kase = { id: 'k1', orgId: 'o', playerId: 'p' };
  const chk = (db, kind) => createEvidenceProvider(db).check(kind, { kase });
  neg(chk({ requests: [], trials: [] }, 'trial_invited').satisfied === false && chk({ requests: [], trials: [] }, 'trial_confirmed').satisfied === false && chk({ requests: [], trials: [] }, 'trial_completed').satisfied === false, 'P10 with nothing recorded, no trial stage has evidence');
  neg(chk({}, 'trial_invited').satisfied === false && chk({}, 'trial_invited').reason === 'requests_store_unavailable' && chk({}, 'trial_confirmed').reason === 'trials_store_unavailable', 'P10b a missing store is NOT evidence — the provider fails closed and names the store');
  const dbEv = { requests: [{ id: 'r1', type: 'trial', caseId: 'k1', orgId: 'o', playerId: 'p', status: 'pending' }], trials: [] };
  ok(chk(dbEv, 'trial_invited').satisfied === true, 'P11 a pending invitation is evidence for trial_requested');
  dbEv.requests[0].status = 'declined';
  neg(chk(dbEv, 'trial_invited').satisfied === false, 'P11b a declined invitation is not');
  dbEv.requests[0].status = 'accepted';
  const t = { id: 't', orgId: 'o', playerId: 'p', caseId: 'k1', status: 'awaiting_report', workflowState: 'accepted', schedule: { timezone: 'UTC', revision: 1, confirmedAt: null, sessions: [{ id: 's', startsAt: 10, endsAt: 20, kind: 'training' }], revisions: [] }, attendance: [], completion: null, rev: 1 };
  dbEv.trials.push(t);
  neg(chk(dbEv, 'trial_confirmed').satisfied === false, 'P12 a proposed, unconfirmed schedule is not evidence for trial_scheduled');
  t.schedule.confirmedAt = 5; t.workflowState = 'scheduled';
  ok(chk(dbEv, 'trial_confirmed').satisfied === true, 'P12b a confirmed schedule is');
  neg(chk(dbEv, 'trial_completed').satisfied === false, 'P13 scheduled is not completed');
  t.completion = { state: 'cancelled', at: 30 }; t.workflowState = 'cancelled';
  neg(chk(dbEv, 'trial_completed').satisfied === false, 'P13b cancelled is not completed either');
  t.completion = { state: 'completed', at: 30 }; t.workflowState = 'completed';
  ok(chk(dbEv, 'trial_completed').satisfied === true, 'P13c an explicit completion is');
  t.subjectRemovedAt = 40;
  ok(chk(dbEv, 'trial_completed').satisfied === true, 'P13d a tombstoned completed trial is still what happened');
}

// =================================================================== HTTP
section('HTTP — booting a real server (test clock enabled)');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot() {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', SCOUTBOX_TEST_CLOCK: '1' }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let server = await boot();

async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, text: data === null ? await r.text().catch(() => '') : null };
}
const raw = async (url, token) => { const r = await fetch(`${BASE}${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); return { status: r.status, text: await r.text() }; };
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const guardianLogin = async (guardianId) => (await j('POST', '/auth/guardian/login', { guardianId })).body;
/** The one clock: the test header pins "now" for that request only. */
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });

/** Read SSE frames for a while, as one identity. */
async function sseCollect(token, ms) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController();
  const frames = [];
  const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const done = (async () => { try { for (;;) { const { value, done: d } = await reader.read(); if (d) break; frames.push(dec.decode(value)); } } catch { /* aborted */ } })();
  return { stop: async () => { await sleep(ms); ac.abort(); await done; return frames.join(''); } };
}

const ERROR_BODIES = [];
const collect = (label, r) => { if (r.status >= 400) ERROR_BODIES.push({ label, status: r.status, body: r.body }); return r; };

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const agent = await login('org-northstar', 'Tomás Rivera', 'Director');
const kola = await playerLogin('pl-adeyemi');
const mateus = await playerLogin('pl-carvalho');
const guni = await playerLogin('pl-guni');
const amara = await guardianLogin('gd-amara');
const marek = await guardianLogin('gd-marek');
ok([maria, tom, rita, agent, kola, mateus, guni, amara, marek].every((x) => x?.token), 'HTTP actors logged in');

/** Open a room for a player and move it to under_review (a trial may be requested from there). */
async function reviewed(token, playerId) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  const RID = r.status === 201 ? r.body.room.roomId : r.body?.existingRoomId;
  if (!RID) throw new Error(`room for ${playerId}: ${r.status} ${JSON.stringify(r.body)}`);
  const jr = (await j('GET', `/org/rooms/${RID}/journey`, undefined, token)).body;
  if (jr.lifecycle.currentStage === 'watching') {
    const mv = await j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'startReview', expectedRev: jr.case.rev }, token);
    if (mv.status !== 200) throw new Error(`startReview ${RID}: ${mv.status} ${JSON.stringify(mv.body)}`);
  }
  return RID;
}
const stage = async (RID, token = maria.token) => (await j('GET', `/org/rooms/${RID}/journey`, undefined, token)).body.lifecycle.currentStage;
const T0 = Date.now();
const SLOTS = (base = T0) => [{ startsAt: base + 2 * H, endsAt: base + 4 * H, kind: 'training' }, { startsAt: base + 26 * H, endsAt: base + 28 * H, kind: 'small_sided' }];
const INVITE = (extra = {}) => ({ timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B, Dome Road' }, message: 'Come and train with the U23s.', instructions: 'Ask for Priya at reception.', slots: SLOTS(), ...extra });
const invite = (RID, token = maria.token, extra = {}, headers = {}) => j('POST', `/org/rooms/${RID}/trials`, INVITE(extra), token, headers);
const pendingTrial = async (token, path = '/player/inbox') => (await j('GET', path, undefined, token)).body.find((r) => r.type === 'trial' && r.status === 'pending') ?? null;
const trialsOf = async (RID, token = maria.token) => (await j('GET', `/org/rooms/${RID}/trials`, undefined, token)).body;
const trial = async (RID, tid, token = maria.token) => (await j('GET', `/org/rooms/${RID}/trials/${tid}`, undefined, token)).body;
const notifs = async (path, token) => (await j('GET', path, undefined, token)).body;
/** Blocks are lifted by Trust & Safety only (existing rule) — the suite does it through that door. */
async function unblock(playerId, orgId) {
  const blocks = (await j('GET', '/admin/blocks', undefined, undefined, ADMIN)).body;
  for (const b of blocks.filter((x) => x.playerId === playerId && x.orgId === orgId)) await j('POST', `/admin/blocks/${b.id}/lift`, {}, undefined, ADMIN);
}

// ================================================================= J — adult
section('J — the adult journey: invitation → acceptance → schedule → attendance → completion, one stage per fact');
const J = {};
{
  const room = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi', sourceContext: 'search' }, maria.token);
  J.RID = room.body.room.roomId;
  const early = collect('invite at watching', await invite(J.RID));
  neg(expect(early, 409, 'TRIAL_CASE_STATE'), 'J0 a case at `watching` cannot request a trial — the club has not even started its review (409 TRIAL_CASE_STATE)');
  neg(Array.isArray(early.body.allowed) && early.body.allowed.includes('under_review') && early.body.allowed.includes('shortlisted') && !early.body.allowed.includes('watching'), 'J0b and the refusal names the case states that can');
  const jr0 = (await j('GET', `/org/rooms/${J.RID}/journey`, undefined, maria.token)).body;
  await j('POST', `/org/rooms/${J.RID}/lifecycle`, { action: 'startReview', expectedRev: jr0.case.rev }, maria.token);
  const direct = collect('direct move', await j('POST', `/org/rooms/${J.RID}/lifecycle`, { action: 'planTrial', expectedRev: jr0.case.rev + 1 }, maria.token));
  neg(expect(direct, 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), 'J1 moving the case to trial_requested BY HAND is refused — there is no invitation to evidence it (422 LIFECYCLE_EVIDENCE_REQUIRED, D-3)');
  const list0 = await trialsOf(J.RID);
  ok(list0.items.length === 0 && list0.invitation === null && list0.routing.available === true && list0.routing.type === 'player' && list0.routing.minor === false && list0.canWrite === true && list0.case.acceptsInvitation === true, 'J2 before anything: no trial, no invitation, the routing says adult player, the lead may write');
  const playerNotifsBefore = (await notifs('/player/notifications', kola.token)).length;
  const inv = collect('invite', await invite(J.RID, maria.token, { clientKey: 'J-inv' }));
  ok(inv.status === 201 && inv.body.invitation.status === 'pending' && inv.body.invitation.slots.length === 2 && inv.body.case.to === 'trial_requested', 'J3 the invitation is sent: a pending request with two slots, and the case advanced to trial_requested through the writer');
  J.REQ = inv.body.invitation.id;
  ok(await stage(J.RID) === 'trial_requested', 'J3b the case is at trial_requested');
  neg((await trialsOf(J.RID)).items.length === 0, 'J4 an invitation is NOT a trial — no trial row exists until someone accepts');
  const again = collect('second invite', await invite(J.RID, maria.token, { clientKey: 'J-inv-2' }));
  neg(expect(again, 409, 'TRIAL_ALREADY_INVITED') && again.body.current?.requestId === J.REQ, 'J5 a second invitation while one is pending is refused and names the live one');
  const replay = await invite(J.RID, maria.token, { clientKey: 'J-inv' });
  ok(replay.status === 200 && replay.body.idempotent === true && replay.body.invitation.id === J.REQ, 'J5b replaying the SAME invitation with the same clientKey returns the original — no second request');
  const conflict = collect('key conflict', await invite(J.RID, maria.token, { clientKey: 'J-inv', message: 'Different words entirely.' }));
  neg(expect(conflict, 409, 'TRIAL_IDEMPOTENCY_CONFLICT'), 'J5c the same key with a different payload is a conflict, not a silent replay');

  // The recipient's view of the invitation.
  const p = await pendingTrial(kola.token);
  ok(!!p && p.id === J.REQ && p.trialDetails.slots.length === 2 && p.trialDetails.proposedDate === localDay(T0 + 2 * H, 'Europe/London') && p.trialDetails.slots[0].timezone === 'Europe/London', 'J6 the player sees the invitation in the existing Inbox with its slots, days and the organiser timezone');
  neg(!has(p, 'Gate B') && !has(p, 'Ask for Priya') && !has(p, J.RID) && p.caseId === undefined && p.recipient === undefined && p.keys === undefined, 'J7 the Inbox view carries neither the exact address, the arrival instructions, the case id, the recipient snapshot nor the club\'s idempotency key (D-23)');
  ok(p.trialDetails.venue === 'Eastport Dome, Eastport' && p.trialDetails.slots[0].venue.name === 'Eastport Dome', 'J7b venue name and town are shared before acceptance');
  const badSlot = collect('bad slot', await j('POST', `/player/requests/${J.REQ}/respond`, { accept: true, chosenSlot: '2030-01-01' }, kola.token));
  neg(badSlot.status === 400 && (await pendingTrial(kola.token))?.id === J.REQ, 'J8 accepting with a day the club never offered is refused and the invitation stays pending (P4A-D12)');
  const acc = await j('POST', `/player/requests/${J.REQ}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, kola.token);
  ok(acc.status === 200 && acc.body.status === 'accepted' && typeof acc.body.trialId === 'string', 'J9 the player accepts the first slot through the existing respond route and learns the trial id');
  J.TID = acc.body.trialId;
  const t1 = (await trialsOf(J.RID)).items[0];
  ok(t1?.id === J.TID && t1.workflowState === 'scheduled' && t1.schedule.revision === 1 && t1.schedule.confirmedAt > 0 && t1.schedule.sessions.length === 1 && t1.schedule.sessions[0].startsAt === T0 + 2 * H && t1.rev === 1 && t1.caseId === J.RID, 'J10 accepting a concrete slot IS the schedule confirmation: one trial, scheduled, revision 1 confirmed by the recipient, rev 1 (D-4)');
  ok(await stage(J.RID) === 'trial_scheduled', 'J10b and the case advanced to trial_scheduled in the same save — the writer, not the trial, moved it (D-15)');
  neg(/^tses-\d+$/.test(t1.schedule.sessions[0].id) && t1.schedule.sessions[0].id !== p.trialDetails.slots[0].id, 'J10c the session id is a minted id — not an array position, not the slot id');
  ok(t1.schedule.sessions[0].venue.address === 'Gate B, Dome Road' && t1.schedule.sessions[0].instructions === 'Ask for Priya at reception.', 'J11 the club view of the trial carries the address and instructions it wrote');
  ok(t1.legacy === false && t1.reportStatus === 'awaiting_report' && t1.hasReport === false, 'J12 the M12 report obligation is untouched: awaiting_report, no report');
  J.SID = t1.schedule.sessions[0].id;
  neg((await trialsOf(J.RID)).invitation.status === 'accepted' && (await trialsOf(J.RID)).invitation.trialId === J.TID, 'J13 the invitation is now accepted and points at the trial');

  // Attendance and completion, with the clock.
  const early2 = collect('attendance early', await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/sessions/${J.SID}/attendance`, { state: 'attended', expectedRev: 1 }, maria.token));
  neg(expect(early2, 409, 'TRIAL_INVALID_STATE') && early2.body.current?.sessionId === J.SID, 'J14 attendance cannot be recorded before the session starts');
  const compEarly = collect('complete early', await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/complete`, { expectedRev: 1 }, maria.token));
  neg(expect(compEarly, 409, 'TRIAL_COMPLETION_REQUIREMENTS_NOT_MET') && compEarly.body.reasons.join(',') === 'no_attended_session,last_session_not_ended', 'J15 completing before attendance names both missing requirements (D-5)');
  neg(await stage(J.RID) === 'trial_scheduled', 'J15b and the case did not move');
  const att = await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/sessions/${J.SID}/attendance`, { state: 'attended', expectedRev: 1, clientKey: 'J-att' }, maria.token, at(T0 + 3 * H));
  ok(att.status === 200 && att.body.trial.rev === 2 && att.body.trial.attendanceHistory.length === 1 && att.body.trial.attendanceHistory[0].source === 'manual' && att.body.trial.attendanceHistory[0].recordedBy.name === 'Maria Keane', 'J16 once the session has started, attendance is recorded (manual, by name) and the rev moves to 2');
  const compRunning = collect('complete running', await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/complete`, { expectedRev: 2 }, maria.token, at(T0 + 3 * H)));
  neg(expect(compRunning, 409, 'TRIAL_COMPLETION_REQUIREMENTS_NOT_MET') && compRunning.body.reasons.join(',') === 'last_session_not_ended', 'J17 attended, but the session is still running — not complete');
  const comp = await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/complete`, { expectedRev: 2, clientKey: 'J-comp' }, maria.token, at(T0 + 5 * H));
  ok(comp.status === 200 && comp.body.trial.workflowState === 'completed' && comp.body.trial.completion.state === 'completed' && comp.body.trial.completion.at === T0 + 5 * H && comp.body.case.to === 'trial_completed' && comp.body.trial.rev === 3, 'J18 after the last session ended, completion is explicit, stamped with the one clock, and the case advanced to trial_completed');
  ok(await stage(J.RID) === 'trial_completed', 'J18b the case is at trial_completed');
  const compReplay = await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/complete`, { expectedRev: 2, clientKey: 'J-comp' }, maria.token, at(T0 + 5 * H));
  ok(compReplay.status === 200 && compReplay.body.idempotent === true && compReplay.body.trial.rev === 3, 'J19 replaying the completion with its key is a replay, even with the stale rev — the key answers first');
  const compTwice = collect('complete twice', await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/complete`, { expectedRev: 3 }, maria.token, at(T0 + 6 * H)));
  neg(expect(compTwice, 409, 'TRIAL_INVALID_STATE'), 'J19b completing a completed trial (no key) is an invalid state');
  neg(comp.body.trial.reportStatus === 'awaiting_report', 'J20 completion is NOT the report: the mandatory report is still owed (REPORTS_OUTSTANDING preserved)');
  const tv = await trial(J.RID, J.TID);
  ok(tv.trial.history.map((h) => h.action).join(',') === 'trial_accepted,trial_schedule_confirmed,trial_attendance_recorded,trial_completed', 'J21 the trial history is append-only and in order: accepted, confirmed, attendance, completed');
  ok(tv.assessments.length === 0 && tv.evidence.length === 0, 'J21b no assessment and no evidence exist because nobody wrote one — nothing is derived from completion');
  const pn = await notifs('/player/notifications', kola.token);
  ok(pn.length > playerNotifsBefore && pn.some((n) => n.type === 'trial_day' && n.refId === J.TID && /completed/.test(n.text)), 'J22 the player was told the trial was recorded as completed (trial_day, deep-linked to the trial)');
  neg(!pn.some((n) => /assess|rating|recommend/i.test(n.text)), 'J22b and nothing in the notifications speaks of assessment or judgement');
}

// ============================================================ V — recipient view
section('V — the recipient\'s own view: what crosses the edge and what never does');
{
  const mine = (await j('GET', '/player/trials', undefined, kola.token)).body;
  const t = mine.find((x) => x.id === J.TID);
  ok(!!t && t.workflow && t.workflow.workflowState === 'completed' && t.workflow.schedule.sessions.length === 1 && t.workflow.schedule.sessions[0].venue.address === 'Gate B, Dome Road' && t.workflow.schedule.sessions[0].instructions === 'Ask for Priya at reception.', 'V1 the player\'s own trial carries the confirmed sessions with the address and instructions (shared after acceptance)');
  neg(!has(t, J.RID) && t.workflow.caseId === undefined && t.workflow.history === undefined && t.workflow.attendanceHistory === undefined && !has(t, 'evidence'), 'V2 and never the case id, the history internals, attendance notes or evidence links');
  ok(t.workflow.completion.state === 'completed' && t.workflow.completion.byKind === 'org', 'V3 the completion is visible as a state with the kind of actor, nothing more');
  const shared = (await j('GET', `/player/recruitment/shared`, undefined, kola.token)).body;
  const sh = shared?.items ?? shared?.records ?? (Array.isArray(shared) ? shared : []);
  const st = sh.find?.((r) => r.kind === 'trial' && r.id === J.TID);
  ok(!st || (st.workflowState === 'completed' && st.caseId === undefined && !has(st, J.RID)), 'V4 the shared-records surface (if exposed to the player) shows the trial as state + ids, without a case id');
  const other = (await j('GET', '/player/trials', undefined, mateus.token)).body;
  neg(!other.some((x) => x.id === J.TID), 'V5 another adult player does not see Kola\'s trial');
  const g = collect('guardian foreign', await j('POST', `/guardian/trials/${J.TID}/confirm-schedule`, {}, amara.token));
  neg(expect(g, 404, 'TRIAL_NOT_FOUND'), 'V6 a guardian who is not this player\'s guardian cannot act on the trial (404, not 403 — no enumeration)');
  const m = collect('other player confirm', await j('POST', `/player/trials/${J.TID}/confirm-schedule`, {}, mateus.token));
  neg(expect(m, 404, 'TRIAL_NOT_FOUND'), 'V7 another player cannot confirm it either');
  const org2 = collect('foreign org', await j('GET', `/org/rooms/${J.RID}/trials`, undefined, rita.token));
  neg(org2.status === 404, 'V8 another organisation cannot read the room\'s trials (404)');
}

// ================================================================ S — schedule
section('S — schedule semantics: proposal, confirmation, revisions, material change, ended sessions');
const S = {};
{
  S.RID = await reviewed(maria.token, 'pl-carvalho');
  const inv = await invite(S.RID, maria.token, { slots: [SLOTS()[0]] });
  ok(inv.status === 201, 'S0 Mateus is invited with one slot');
  const p = await pendingTrial(mateus.token);
  const acc = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, mateus.token);
  S.TID = acc.body.trialId;
  const t0 = (await trialsOf(S.RID)).items.find((t) => t.id === S.TID);
  ok(t0.workflowState === 'scheduled' && t0.rev === 1, 'S1 accepted and scheduled at revision 1');
  S.SID = t0.schedule.sessions[0].id;
  const V = (extra = {}) => ({ name: 'Eastport Dome', town: 'Eastport', address: 'Gate B', ...extra });
  const base = T0 + 48 * H;
  const body = (sessions, extra = {}) => ({ timezone: 'Europe/London', sessions, expectedRev: extra.expectedRev, ...extra });

  // A cosmetic revision keeps the confirmation.
  const cosmetic = await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ id: S.SID, startsAt: T0 + 2 * H, endsAt: T0 + 4 * H, kind: 'drill', venue: V(), instructions: 'Bring shin pads.' }], { expectedRev: 1, clientKey: 'S-cos' }), maria.token);
  ok(cosmetic.status === 200 && cosmetic.body.requiresConfirmation === false && cosmetic.body.material === false && cosmetic.body.trial.workflowState === 'scheduled' && cosmetic.body.trial.schedule.revision === 2 && cosmetic.body.trial.rev === 2, 'S2 changing the kind and the instructions is not material: revision 2, still scheduled, no re-confirmation asked (D-8)');
  ok(cosmetic.body.trial.schedule.sessions[0].id === S.SID && cosmetic.body.trial.schedule.sessions[0].instructions === 'Bring shin pads.', 'S2b the session kept its id across the revision');
  ok(cosmetic.body.trial.revisions.length === 2 && cosmetic.body.trial.revisions[0].supersededAt > 0 && cosmetic.body.trial.revisions[1].supersededAt === null && cosmetic.body.trial.revisions[1].confirmedAt > 0, 'S3 revisions are append-only: the first is superseded, the second is current and carries the standing confirmation');
  // A material revision clears it.
  const material = await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ id: S.SID, startsAt: base + 2 * H, endsAt: base + 4 * H, venue: V() }, { startsAt: base + 26 * H, endsAt: base + 27 * H, kind: 'match', venue: V({ name: 'Riverside Pitch' }) }], { expectedRev: 2, clientKey: 'S-mat', reason: 'Pitch unavailable on the first day.' }), maria.token);
  ok(material.status === 200 && material.body.requiresConfirmation === true && material.body.material === true && material.body.trial.workflowState === 'accepted' && material.body.trial.schedule.revision === 3 && material.body.trial.schedule.confirmedAt === null && material.body.trial.schedule.sessions.length === 2, 'S4 moving a session and adding another is material: revision 3, confirmation cleared, the trial is accepted-not-scheduled until the family answers');
  ok(material.body.trial.schedule.sessions[0].id === S.SID && material.body.trial.schedule.sessions[1].id !== S.SID && material.body.trial.revisions[2].reason === 'Pitch unavailable on the first day.', 'S4b the moved session kept its id, the new one was minted, the reason is on the revision');
  neg(await stage(S.RID) === 'trial_scheduled', 'S4c the case does not regress: a lifecycle stage is history, the trial state is the operational truth');
  const fam = (await j('GET', '/player/trials', undefined, mateus.token)).body.find((x) => x.id === S.TID);
  ok(fam.workflow.awaitingYourConfirmation === true && fam.workflow.workflowState === 'accepted' && fam.workflow.schedule.revision === 3, 'S5 the player sees a revision awaiting their confirmation');
  const attWhileProposed = collect('attendance proposed', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/sessions/${S.SID}/attendance`, { state: 'attended', expectedRev: 3 }, maria.token, at(base + 3 * H)));
  neg(expect(attWhileProposed, 409, 'TRIAL_INVALID_STATE'), 'S6 attendance cannot be recorded against an unconfirmed revision');
  const compProposed = collect('complete proposed', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/complete`, { expectedRev: 3 }, maria.token, at(base + 30 * H)));
  neg(expect(compProposed, 409, 'TRIAL_INVALID_STATE') && compProposed.body.current?.workflowState === 'accepted', 'S6b nor can it complete — the state gate answers before the completion gate');
  const declined = await j('POST', `/player/trials/${S.TID}/decline-schedule`, { reason: 'I have exams that week.' }, mateus.token);
  ok(declined.status === 200 && declined.body.trial.workflowState === 'accepted', 'S7 the player declines the proposed revision — the trial stays accepted, nothing is cancelled');
  const declineTwice = await j('POST', `/player/trials/${S.TID}/decline-schedule`, {}, mateus.token);
  ok(declineTwice.status === 200 && declineTwice.body.idempotent === true, 'S7b declining twice is a replay');
  const on = (await notifs('/org/notifications', maria.token)).find((n) => n.type === 'trial_day' && n.refId === S.TID && /declined the proposed trial schedule/.test(n.text));
  ok(!!on && on.text.includes('I have exams that week.'), 'S7c the club lead is told, with the reason the family wrote for them');
  const confirmDeclined = collect('confirm declined', await j('POST', `/player/trials/${S.TID}/confirm-schedule`, {}, mateus.token));
  ok(confirmDeclined.status === 200 && confirmDeclined.body.trial.workflowState === 'scheduled', 'S8 the player may still confirm the same revision afterwards (changed their mind) — a decline is not final');
  ok(await stage(S.RID) === 'trial_scheduled', 'S8b the case is (still) trial_scheduled');
  const confirmAgain = await j('POST', `/player/trials/${S.TID}/confirm-schedule`, {}, mateus.token);
  ok(confirmAgain.status === 200 && confirmAgain.body.idempotent === true, 'S8c confirming twice is a replay');
  // Revision rules around sessions that happened.
  const tNow = (await trialsOf(S.RID)).items.find((t) => t.id === S.TID);
  const rev = tNow.rev;
  const att = await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/sessions/${S.SID}/attendance`, { state: 'partial', expectedRev: rev, note: 'Left early — school run.' }, maria.token, at(base + 3 * H));
  ok(att.status === 200, 'S9 attendance (partial, with a club note) is recorded on the first session');
  const removeAttended = collect('remove attended', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ startsAt: base + 50 * H, endsAt: base + 52 * H, venue: V() }], { expectedRev: rev + 1 }), maria.token, at(base + 3 * H)));
  neg(expect(removeAttended, 409, 'TRIAL_INVALID_STATE') && removeAttended.body.current?.sessionId === S.SID, 'S10 a revision that drops a session with attendance recorded is refused — what happened is not edited away');
  const moveEnded = collect('move ended', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ id: S.SID, startsAt: base + 2.5 * H, endsAt: base + 4 * H, venue: V() }, { id: tNow.schedule.sessions[1].id, startsAt: base + 26 * H, endsAt: base + 27 * H, venue: V() }], { expectedRev: rev + 1 }), maria.token, at(base + 5 * H)));
  neg(expect(moveEnded, 409, 'TRIAL_INVALID_STATE') && moveEnded.body.current?.sessionId === S.SID, 'S10b moving a session that has ended (to another time in the past) is refused as editing what happened');
  const moveEndedFwd = collect('move ended forward', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ id: S.SID, startsAt: base + 6 * H, endsAt: base + 8 * H, venue: V() }, { id: tNow.schedule.sessions[1].id, startsAt: base + 26 * H, endsAt: base + 27 * H, venue: V() }], { expectedRev: rev + 1 }), maria.token, at(base + 5 * H)));
  neg(expect(moveEndedFwd, 409, 'TRIAL_INVALID_STATE') && moveEndedFwd.body.current?.sessionId === S.SID, 'S10c moving an ended session into the future is refused as editing what happened');
  const keepEnded = await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ id: S.SID, startsAt: base + 2 * H, endsAt: base + 4 * H, venue: V() }, { id: tNow.schedule.sessions[1].id, startsAt: base + 30 * H, endsAt: base + 31 * H, venue: V() }], { expectedRev: rev + 1, clientKey: 'S-keep' }), maria.token, at(base + 5 * H));
  ok(keepEnded.status === 200 && keepEnded.body.material === true && keepEnded.body.trial.schedule.sessions[0].id === S.SID, 'S11 a revision that carries the ended session unchanged and moves the future one is accepted (and needs confirming)');
  const unknownId = collect('unknown id', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ id: 'tses-999999', startsAt: base + 60 * H, endsAt: base + 61 * H, venue: V() }, { id: S.SID, startsAt: base + 2 * H, endsAt: base + 4 * H, venue: V() }], { expectedRev: keepEnded.body.trial.rev }), maria.token, at(base + 5 * H)));
  neg(expect(unknownId, 404, 'TRIAL_SESSION_NOT_FOUND'), 'S12 a revision naming a session id this trial never had is refused');
  const overlap = collect('overlap', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ id: S.SID, startsAt: base + 2 * H, endsAt: base + 4 * H, venue: V() }, { startsAt: base + 3 * H, endsAt: base + 5 * H, venue: V() }], { expectedRev: keepEnded.body.trial.rev }), maria.token, at(base + 1 * H)));
  neg(expect(overlap, 400, 'TRIAL_SCHEDULE_INVALID'), 'S13 overlapping sessions are refused over HTTP too');
  const tz = collect('tz', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, { ...body([{ id: S.SID, startsAt: base + 2 * H, endsAt: base + 4 * H, venue: V() }], { expectedRev: keepEnded.body.trial.rev }), timezone: 'Europe/london' }, maria.token, at(base + 1 * H)));
  neg(expect(tz, 400, 'TRIAL_TIMEZONE_INVALID'), 'S14 a miscased zone is refused (400 TRIAL_TIMEZONE_INVALID)');
  const twenty = Array.from({ length: 20 }, (_, i) => ({ startsAt: base + 100 * H + i * 24 * H, endsAt: base + 101 * H + i * 24 * H, venue: V() }));
  const tooMany = collect('21', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ id: S.SID, startsAt: base + 2 * H, endsAt: base + 4 * H, venue: V() }, ...twenty], { expectedRev: keepEnded.body.trial.rev }), maria.token, at(base + 1 * H)));
  neg(expect(tooMany, 400, 'TRIAL_SCHEDULE_INVALID'), 'S15 twenty-one sessions is refused');
  const exactly = await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, body([{ id: S.SID, startsAt: base + 2 * H, endsAt: base + 4 * H, venue: V() }, ...twenty.slice(0, 19)], { expectedRev: keepEnded.body.trial.rev, clientKey: 'S-20' }), maria.token, at(base + 1 * H));
  ok(exactly.status === 200 && exactly.body.trial.schedule.sessions.length === 20 && exactly.body.trial.schedule.sessions.every((s, i, a) => i === 0 || a[i - 1].startsAt <= s.startsAt), 'S16 twenty sessions is accepted and comes back in start order');
  S.REV = exactly.body.trial.rev; S.REVISION = exactly.body.trial.schedule.revision;
  const unfinal = await j('GET', `/org/rooms/${S.RID}/trials/${S.TID}`, undefined, maria.token);
  ok(unfinal.body.trial.revisions.length === S.REVISION && unfinal.body.trial.revisions.filter((r) => r.supersededAt === null).length === 1, `S17 ${S.REVISION} revisions on record, exactly one current`);
  const ics = await raw(`/org/trials/${S.TID}/ics`, maria.token);
  const lines = ics.text.split('\r\n');
  ok(ics.status === 200 && lines.filter((l) => l === 'BEGIN:VEVENT').length === 20 && lines.some((l) => l.startsWith('DTSTART;TZID=Europe/London:')) && lines.filter((l) => l === 'STATUS:TENTATIVE').length === 20 && lines.some((l) => l.startsWith(`SEQUENCE:${S.REVISION}`)), `S18 the ICS export carries one timed VEVENT per session in the organiser zone, from the current revision only, TENTATIVE while unconfirmed (${ics.status}, ${lines.filter((l) => l === 'BEGIN:VEVENT').length} events)`);
  const confirm20 = await j('POST', `/player/trials/${S.TID}/confirm-schedule`, {}, mateus.token);
  const icsC = (await raw(`/org/trials/${S.TID}/ics`, maria.token)).text.split('\r\n');
  ok(confirm20.status === 200 && icsC.filter((l) => l === 'STATUS:CONFIRMED').length === 20, 'S18c once the player confirms, every event is CONFIRMED');
  neg(!ics.text.includes('VALUE=DATE'), 'S18b it is no longer a date-only export');
}

// ============================================================== A — attendance
section('A — attendance is what happened, never how it went; completion is explicit');
const A = {};
{
  A.RID = await reviewed(maria.token, 'pl-osei');
  const osei = await playerLogin('pl-osei');
  const base = T0 + 200 * H;
  const inv = await invite(A.RID, maria.token, { slots: [{ startsAt: base, endsAt: base + 2 * H }, { startsAt: base + 24 * H, endsAt: base + 26 * H }] });
  ok(inv.status === 201, 'A0 Daniel Osei is invited with two slots on two days');
  const p = await pendingTrial(osei.token);
  const acc = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.altSlots[0] }, osei.token);
  A.TID = acc.body.trialId;
  const t = (await trialsOf(A.RID)).items.find((x) => x.id === A.TID);
  ok(t.schedule.sessions.length === 1 && t.schedule.sessions[0].startsAt === base + 24 * H, 'A1 choosing the ALTERNATIVE slot schedules that day, not the first');
  A.SID = t.schedule.sessions[0].id;
  const s = base + 24 * H;
  for (const bad of ['present', 'ATTENDED', 'good', '', null, 1, {}, ['attended']]) {
    const r = collect('bad state', await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/sessions/${A.SID}/attendance`, { state: bad, expectedRev: t.rev }, maria.token, at(s + 10 * MIN)));
    neg(expect(r, 400, 'TRIAL_ATTENDANCE_INVALID') && Array.isArray(r.body.allowed), `A2 attendance "${JSON.stringify(bad)}" is not a state — the vocabulary is closed and the refusal lists it`);
  }
  const rating = collect('rating in note', await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/sessions/${A.SID}/attendance`, { state: 'attended', rating: 5, expectedRev: t.rev, note: 'x'.repeat(TRIAL_LIMITS.note + 1) }, maria.token, at(s + 10 * MIN)));
  neg(expect(rating, 400, 'TRIAL_ATTENDANCE_INVALID'), 'A3 an over-long note is refused; there is no rating field to accept');
  const ghost = collect('ghost session', await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/sessions/tses-nope/attendance`, { state: 'attended', expectedRev: t.rev }, maria.token, at(s + 10 * MIN)));
  neg(expect(ghost, 404, 'TRIAL_SESSION_NOT_FOUND'), 'A4 attendance on a session that is not on this trial is refused');
  const noShow = await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/sessions/${A.SID}/attendance`, { state: 'no_show', expectedRev: t.rev, clientKey: 'A-1' }, maria.token, at(s + 10 * MIN));
  ok(noShow.status === 200 && noShow.body.trial.schedule.sessions[0].attendance?.state === 'no_show', 'A5 a no-show is recorded as the current attendance');
  const compNoShow = collect('complete no-show', await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/complete`, { expectedRev: noShow.body.trial.rev }, maria.token, at(s + 3 * H)));
  neg(expect(compNoShow, 409, 'TRIAL_COMPLETION_REQUIREMENTS_NOT_MET') && compNoShow.body.reasons.join(',') === 'no_attended_session', 'A6 a trial nobody attended cannot be completed — absence is not participation');
  const corrected = await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/sessions/${A.SID}/attendance`, { state: 'attended', expectedRev: noShow.body.trial.rev, clientKey: 'A-2', note: 'Arrived late, the gate was locked.' }, maria.token, at(s + 20 * MIN));
  ok(corrected.status === 200 && corrected.body.trial.attendanceHistory.length === 2 && corrected.body.trial.attendanceHistory[1].state === 'attended' && corrected.body.trial.schedule.sessions[0].attendance.state === 'attended', 'A7 a correction is a second record: the history keeps both, the current state is the last');
  const replay = await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/sessions/${A.SID}/attendance`, { state: 'attended', expectedRev: 999, clientKey: 'A-2', note: 'Arrived late, the gate was locked.' }, maria.token, at(s + 20 * MIN));
  ok(replay.status === 200 && replay.body.idempotent === true && replay.body.trial.attendanceHistory.length === 2, 'A7b replaying the record with its key adds nothing');
  const tmw = (await trialsOf(A.RID)).items.find((x) => x.id === A.TID);
  ok(tmw.schedule.sessions[0].attendance.state === 'attended', 'A8 not_recorded is derived, never stored: a session with no record simply has none');
  const comp = await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/complete`, { expectedRev: corrected.body.trial.rev }, maria.token, at(s + 2 * H));
  ok(comp.status === 200 && comp.body.trial.completion.state === 'completed' && comp.body.case.to === 'trial_completed', 'A9 completed at the exact moment the last session ends (end == now)');
  const late = collect('attendance after completion', await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/sessions/${A.SID}/attendance`, { state: 'partial', expectedRev: comp.body.trial.rev }, maria.token, at(s + 3 * H)));
  neg(expect(late, 409, 'TRIAL_INVALID_STATE'), 'A10 attendance cannot be changed after completion');
  const resched = collect('reschedule after completion', await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/reschedule`, { timezone: 'UTC', expectedRev: comp.body.trial.rev, sessions: [{ id: A.SID, startsAt: s, endsAt: s + 2 * H, venue: { name: 'X', town: 'Y' } }] }, maria.token, at(s + 3 * H)));
  neg(expect(resched, 409, 'TRIAL_INVALID_STATE'), 'A10b nor rescheduled');
  const cancel = collect('cancel after completion', await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/cancel`, { expectedRev: comp.body.trial.rev, reason: 'Too late.' }, maria.token, at(s + 3 * H)));
  neg(expect(cancel, 409, 'TRIAL_INVALID_STATE'), 'A10c nor cancelled');
  const famCancel = await j('POST', `/player/trials/${A.TID}/cancel`, {}, osei.token);
  ok(famCancel.status === 200 && famCancel.body.idempotent === false && famCancel.body.trial.workflowState === 'completed', 'A10d the player cancelling a completed trial changes nothing (200, not a replay, not an error)');
  const passport = (await j('GET', '/player/football-passport', undefined, osei.token)).body;
  const ev = passport.timeline.find((e) => e.type === 'trial_attended' && e.source?.id === A.TID);
  ok(!!ev && ev.legacy === false && ev.attendedSessions === 1, 'A11 the Passport shows trial_attended keyed on the RECORDED attendance, flagged non-legacy (D-14)');
}

// ================================================================= M — minor
section('M — the minor journey: the guardian is the recipient; the child\'s device carries the outcome line');
const M = {};
{
  M.RID = await reviewed(maria.token, 'pl-guni');
  const list = await trialsOf(M.RID);
  ok(list.routing.available === true && list.routing.type === 'guardian' && list.routing.minor === true, 'M0 the routing for Guni (13) is the verified guardian');
  const guniNotifsBefore = (await notifs('/player/notifications', guni.token)).length;
  const inv = await invite(M.RID, maria.token, { clientKey: 'M-inv' });
  ok(inv.status === 201 && inv.body.routing.type === 'guardian' && inv.body.invitation.routedTo === 'guardian', 'M1 the invitation is routed to the guardian');
  M.REQ = inv.body.invitation.id;
  const childInbox = (await j('GET', '/player/inbox', undefined, guni.token)).body.find((r) => r.id === M.REQ);
  neg(!!childInbox && childInbox.guardianManaged === true && !has(childInbox, 'Come and train') && !has(childInbox, 'slots') && !has(childInbox, 'Gate B'), 'M2 the child\'s own Inbox shows a guardian-managed line — no message, no slots, no address');
  const childAccept = collect('child accept', await j('POST', `/player/requests/${M.REQ}/respond`, { accept: true, chosenSlot: localDay(T0 + 2 * H, 'Europe/London') }, guni.token));
  neg(childAccept.status === 403, 'M3 the child cannot accept (403 — guardian-managed)');
  const gp = await pendingTrial(amara.token, '/guardian/inbox');
  ok(!!gp && gp.id === M.REQ && gp.trialDetails.slots.length === 2 && !has(gp, 'Gate B') && !has(gp, 'Ask for Priya'), 'M4 the guardian sees the invitation with its slots, and not yet the address or instructions');
  const wrongGuardian = collect('wrong guardian', await j('POST', `/guardian/requests/${M.REQ}/respond`, { accept: true, chosenSlot: gp.trialDetails.proposedDate }, marek.token));
  neg(wrongGuardian.status === 404, 'M5 another guardian cannot answer it (404)');
  // Revoke the guardian's identity check between invitation and acceptance: the route is re-derived at acceptance.
  await j('POST', '/admin/guardians/gd-amara/idv', { approved: false }, undefined, ADMIN);
  const revoked = collect('revoked accept', await j('POST', `/guardian/requests/${M.REQ}/respond`, { accept: true, chosenSlot: gp.trialDetails.proposedDate }, amara.token));
  neg(expect(revoked, 422, 'TRIAL_GUARDIAN_REQUIRED') && (await pendingTrial(amara.token, '/guardian/inbox'))?.id === M.REQ, 'M6 a guardian whose verification was withdrawn cannot accept — re-derived NOW, the invitation stays pending (D-7)');
  const listRevoked = await trialsOf(M.RID);
  neg(listRevoked.routing.available === false && listRevoked.routing.reason === 'TRIAL_GUARDIAN_REQUIRED', 'M6b the club sees the routing as unavailable while the guardian route is broken');
  await j('POST', '/admin/guardians/gd-amara/idv', { approved: true }, undefined, ADMIN);
  const acc = await j('POST', `/guardian/requests/${M.REQ}/respond`, { accept: true, chosenSlot: gp.trialDetails.proposedDate }, amara.token);
  ok(acc.status === 200 && acc.body.status === 'accepted' && typeof acc.body.trialId === 'string', 'M7 the restored guardian accepts');
  M.TID = acc.body.trialId;
  const t = (await trialsOf(M.RID)).items.find((x) => x.id === M.TID);
  ok(t.workflowState === 'scheduled' && t.recipient.type === 'guardian' && t.recipient.minor === true && t.guardianApproved === true && t.acceptedBy === 'guardian', 'M8 the trial is scheduled with the guardian as recipient');
  neg(!has(t, 'gd-amara'), 'M8b the club view does not carry the guardian\'s id');
  ok(await stage(M.RID) === 'trial_scheduled', 'M8c the case advanced through the writer, with the guardian as actor');
  const gv = (await j('GET', '/guardian/trials', undefined, amara.token)).body.find((x) => x.id === M.TID);
  ok(gv?.workflow?.workflowState === 'scheduled' && gv.workflow.schedule.sessions[0].venue.address === 'Gate B, Dome Road' && gv.workflow.schedule.sessions[0].instructions === 'Ask for Priya at reception.', 'M9 the guardian now holds the address and instructions');
  const cv = (await j('GET', '/player/trials', undefined, guni.token)).body.find((x) => x.id === M.TID);
  ok(!!cv && cv.workflow?.guardianManaged === true && cv.workflow.workflowState === 'scheduled', 'M10 the child\'s own device carries the guardian-managed outcome line');
  neg(!has(cv.workflow, 'Gate B') && !has(cv.workflow, 'Ask for Priya') && cv.workflow.schedule === undefined && cv.workflow.completion === undefined, 'M10b and not the sessions, the address, the instructions or the completion detail (privacy matrix §112)');
  const childConfirm = collect('child confirm', await j('POST', `/player/trials/${M.TID}/confirm-schedule`, {}, guni.token));
  neg(childConfirm.status === 403, 'M11 the child cannot confirm a schedule (403 — guardian-managed)');
  const childCancel = collect('child cancel', await j('POST', `/player/trials/${M.TID}/cancel`, {}, guni.token));
  neg(childCancel.status === 403, 'M11b nor cancel');
  // A material reschedule goes to the guardian; the guardian confirms.
  const base = T0 + 300 * H;
  const gNotifsBefore = (await notifs('/guardian/notifications', amara.token)).length;
  const re = await j('POST', `/org/rooms/${M.RID}/trials/${M.TID}/reschedule`, { timezone: 'Europe/London', expectedRev: t.rev, sessions: [{ id: t.schedule.sessions[0].id, startsAt: base, endsAt: base + 2 * H, venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B' } }] }, maria.token);
  ok(re.status === 200 && re.body.requiresConfirmation === true, 'M12 the club moves the session');
  const gn = await notifs('/guardian/notifications', amara.token);
  ok(gn.length > gNotifsBefore && gn.some((n) => n.type === 'trial_day' && n.refId === M.TID && /confirm/.test(n.text)), 'M12b the GUARDIAN is asked to confirm (trial_day, deep-linked)');
  const childN = (await notifs('/player/notifications', guni.token)).slice(0, 6);
  neg(!childN.some((n) => n.type === 'trial_day') && !childN.some((n) => /confirm|Gate B|Priya|\d{2}:\d{2}/.test(n.text)), 'M12c the child received no trial_day notification and nothing with a time, an address or a request to confirm — outcome lines only');
  const gc = await j('POST', `/guardian/trials/${M.TID}/confirm-schedule`, {}, amara.token);
  ok(gc.status === 200 && gc.body.trial.workflowState === 'scheduled' && gc.body.trial.schedule.revision === 2, 'M13 the guardian confirms revision 2');
  // Revoke again after scheduling: the guardian cannot act, the club cannot reschedule, the child still cannot act.
  await j('POST', '/admin/guardians/gd-amara/idv', { approved: false }, undefined, ADMIN);
  const reRevoked = collect('reschedule revoked', await j('POST', `/org/rooms/${M.RID}/trials/${M.TID}/reschedule`, { timezone: 'Europe/London', expectedRev: gc.body.trial.rev, sessions: [{ id: t.schedule.sessions[0].id, startsAt: base + 1 * H, endsAt: base + 3 * H, venue: { name: 'Eastport Dome', town: 'Eastport' } }] }, maria.token));
  neg(expect(reRevoked, 422, 'TRIAL_GUARDIAN_REQUIRED'), 'M14 with the guardian route broken, the club cannot reschedule (the recipient is re-derived on every mutation)');
  const gRevokedCancel = collect('guardian revoked cancel', await j('POST', `/guardian/trials/${M.TID}/cancel`, { reason: 'x' }, amara.token));
  neg(expect(gRevokedCancel, 422, 'TRIAL_GUARDIAN_REQUIRED'), 'M14b an unverified guardian cannot act on the trial');
  const clubCancelOk = await j('POST', `/org/rooms/${M.RID}/trials/${M.TID}/cancel`, { expectedRev: gc.body.trial.rev, reason: 'We cannot proceed without a verified guardian.', clientKey: 'M-cancel' }, maria.token);
  if (clubCancelOk.body?.trial?.completion?.phase !== 'scheduled') console.error('   M15 completion', JSON.stringify(clubCancelOk.body?.trial?.completion), JSON.stringify(gc.body?.trial?.workflowState));
  ok(expect(clubCancelOk, 200, null) && clubCancelOk.body.trial.workflowState === 'cancelled' && clubCancelOk.body.trial.completion.cancelledBy === 'club' && clubCancelOk.body.trial.completion.phase === 'scheduled', 'M15 the club may still CANCEL — a safety notice needs no recipient re-derivation; the completion records who cancelled and at what phase');
  await j('POST', '/admin/guardians/gd-amara/idv', { approved: true }, undefined, ADMIN);
  neg(await stage(M.RID) === 'trial_scheduled', 'M15b the case keeps its stage; cancellation is a trial fact, not a lifecycle regression');
  const cvEnd = (await j('GET', '/player/trials', undefined, guni.token)).body.find((x) => x.id === M.TID);
  ok(cvEnd.workflow.workflowState === 'cancelled' && cvEnd.workflow.workflowLabel === TRIAL_WORKFLOW_LABELS.cancelled, 'M16 the child\'s device shows the outcome line: cancelled');
  // No guardian at all: a minor with no verified route cannot be invited.
  await j('POST', '/admin/guardians/gd-marek/idv', { approved: false }, undefined, ADMIN);
  const noRoute = await reviewed(maria.token, 'pl-tomasz');
  const nr = collect('no route', await invite(noRoute));
  neg(expect(nr, 422, 'TRIAL_GUARDIAN_REQUIRED'), 'M17 a minor with no verified guardian route cannot be invited — fail closed, no direct fallback');
  neg((await trialsOf(noRoute)).invitation === null && await stage(noRoute) === 'under_review', 'M17b nothing was written and the case did not move');
  await j('POST', '/admin/guardians/gd-marek/idv', { approved: true }, undefined, ADMIN);
}

// ================================================================= W — walls
section('W — walls: agency, unverified club, foreign organisation, roles');
{
  const ag = await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, agent.token);
  neg(ag.status !== 201 || expect(collect('agency minor', await invite(ag.body.room?.roomId ?? 'none', agent.token)), 422, 'TRIAL_RECIPIENT_UNAVAILABLE'), 'W1 an agency cannot invite a minor to a trial — the standing wall applies (no room, or 422)');
  const un = await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, rita.token);
  neg(un.status !== 201 || expect(collect('unverified minor', await invite(un.body.room?.roomId ?? 'none', rita.token)), 422, 'TRIAL_RECIPIENT_UNAVAILABLE'), 'W2 an unverified club cannot invite a minor either');
  const adultByAgency = await reviewed(agent.token, 'pl-nowak');
  const aa = await invite(adultByAgency, agent.token);
  ok(aa.status === 201 && aa.body.routing.type === 'player', 'W3 an agency may invite an adult (the wall is about minors)');
  const tomInvite = collect('contributor invite', await invite(await reviewed(maria.token, 'pl-svensson'), tom.token));
  neg(expect(tomInvite, 403, 'TRIAL_NOT_PERMITTED'), 'W4 a contributor (First-Team Scout) cannot invite — trial_write is lead+');
  const tomRead = await trialsOf(J.RID, tom.token);
  ok(tomRead.items.length === 1 && tomRead.canWrite === false && tomRead.canAssess === true, 'W5 a contributor can read the room\'s trials and may assess, but not write');
  for (const [label, r] of [
    ['schedule', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, { timezone: 'UTC', expectedRev: S.REV, sessions: [] }, tom.token)],
    ['cancel', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/cancel`, { expectedRev: S.REV, reason: 'no' }, tom.token)],
    ['attendance', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/sessions/${S.SID}/attendance`, { state: 'attended', expectedRev: S.REV }, tom.token)],
    ['complete', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/complete`, { expectedRev: S.REV }, tom.token)],
    ['link', await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/sessions/${S.SID}/evidence`, { boxSessionId: 'x', expectedRev: S.REV }, tom.token)],
  ]) neg(expect(collect(`tom ${label}`, r), 403, 'TRIAL_NOT_PERMITTED'), `W6 a contributor cannot ${label} (403 TRIAL_NOT_PERMITTED, before any validation)`);
  const foreignTrial = collect('foreign trial id', await j('GET', `/org/rooms/${J.RID}/trials/${S.TID}`, undefined, maria.token));
  neg(expect(foreignTrial, 404, 'TRIAL_NOT_FOUND'), 'W7 a trial id from another room is not found in this room (404)');
  const harbourRoom = await reviewed(rita.token, 'pl-adeyemi');
  const cross = collect('cross-org trial', await j('GET', `/org/rooms/${harbourRoom}/trials/${J.TID}`, undefined, rita.token));
  neg(expect(cross, 404, 'TRIAL_NOT_FOUND'), 'W8 another organisation\'s trial is not found through its own room for the same player (tenant isolation)');
  const crossMut = collect('cross-org mutate', await j('POST', `/org/rooms/${harbourRoom}/trials/${J.TID}/cancel`, { expectedRev: 3, reason: 'not ours' }, rita.token));
  neg(expect(crossMut, 404, 'TRIAL_NOT_FOUND'), 'W8b nor mutated');
  const policy = await j('GET', '/org/recruitment/trial-policy', undefined, tom.token);
  ok(policy.status === 200 && policy.body.workflowStates.length === 5 && policy.body.caseStatuses.includes('under_review') && policy.body.limits.sessions === 20, 'W9 the vocabulary is readable by any org member');
}

// ================================================================ B — blocks
section('B — blocks: before, pending, scheduled — the D-16 policy');
{
  const kim = await playerLogin('pl-kim');
  const bRoom = await reviewed(maria.token, 'pl-kim');
  await j('POST', '/player/block', { orgId: 'org-eastport', reason: 'no thanks' }, kim.token);
  const before = collect('blocked invite', await invite(bRoom));
  neg(expect(before, 403, 'TRIAL_BLOCKED'), 'B1 a blocked club cannot invite (403 TRIAL_BLOCKED)');
  neg((await trialsOf(bRoom)).blocked === true && (await trialsOf(bRoom)).routing.reason === 'TRIAL_BLOCKED', 'B1b the room says so');
  await unblock('pl-kim', 'org-eastport');
  const inv = await invite(bRoom);
  ok(inv.status === 201, 'B2 unblocked: the invitation goes out');
  await j('POST', '/player/block', { orgId: 'org-eastport' }, kim.token);
  const p = await pendingTrial(kim.token);
  const accBlocked = collect('accept blocked', await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, kim.token));
  neg(accBlocked.status === 403 && accBlocked.body.error === 'BLOCKED', 'B3 pending invitation, then a block: the player cannot accept it (existing rule)');
  const decl = await j('POST', `/player/requests/${p.id}/respond`, { accept: false }, kim.token);
  ok(decl.status === 200 && decl.body.status === 'declined', 'B3b but may decline it');
  await unblock('pl-kim', 'org-eastport');
  const cooled = collect('cooldown', await invite(bRoom));
  neg(expect(cooled, 429, 'TRIAL_INVITE_COOLDOWN') && cooled.body.retryAt > Date.now(), 'B4 re-inviting right after a decline is refused with the cooldown and a retryAt (anti-spam)');
  const later = await invite(bRoom, maria.token, { slots: SLOTS(Date.now() + 73 * H) }, at(Date.now() + 73 * H));
  ok(later.status === 201, 'B4b after the cooldown window (test clock) a new invitation is allowed');
  const p2 = await pendingTrial(kim.token);
  const acc = await j('POST', `/player/requests/${p2.id}/respond`, { accept: true, chosenSlot: p2.trialDetails.proposedDate }, kim.token);
  ok(acc.status === 200, 'B5 Kim accepts — a scheduled trial exists');
  const TID = acc.body.trialId;
  const t = (await trialsOf(bRoom)).items.find((x) => x.id === TID);
  const sid = t.schedule.sessions[0].id;
  await j('POST', '/player/block', { orgId: 'org-eastport' }, kim.token);
  const V = { name: 'Eastport Dome', town: 'Eastport' };
  for (const [label, r] of [
    ['reschedule', await j('POST', `/org/rooms/${bRoom}/trials/${TID}/reschedule`, { timezone: 'Europe/London', expectedRev: t.rev, sessions: [{ id: sid, startsAt: T0 + 3 * H, endsAt: T0 + 5 * H, venue: V }] }, maria.token)],
    ['attendance', await j('POST', `/org/rooms/${bRoom}/trials/${TID}/sessions/${sid}/attendance`, { state: 'attended', expectedRev: t.rev }, maria.token, at(T0 + 3 * H))],
    ['complete', await j('POST', `/org/rooms/${bRoom}/trials/${TID}/complete`, { expectedRev: t.rev }, maria.token, at(T0 + 5 * H))],
    ['link', await j('POST', `/org/rooms/${bRoom}/trials/${TID}/sessions/${sid}/evidence`, { boxSessionId: 'bx-1', expectedRev: t.rev }, maria.token)],
  ]) neg(expect(collect(`blocked ${label}`, r), 403, 'TRIAL_BLOCKED'), `B6 scheduled, then blocked: the club cannot ${label} (403 TRIAL_BLOCKED)`);
  const confirmBlocked = collect('confirm while blocked', await j('POST', `/player/trials/${TID}/confirm-schedule`, {}, kim.token));
  neg(expect(confirmBlocked, 403, 'TRIAL_BLOCKED'), 'B7 the player cannot confirm with a club they blocked');
  const assessBlocked = collect('assess while blocked', await j('POST', '/org/assessments', { playerId: 'pl-kim', context: { trialId: TID } }, maria.token));
  neg(assessBlocked.status === 403, 'B8 an assessment in the context of the blocked trial is refused (the player is not visible to the club while blocked)');
  const kimNotifsBefore = (await notifs('/player/notifications', kim.token)).length;
  const cancel = await j('POST', `/org/rooms/${bRoom}/trials/${TID}/cancel`, { expectedRev: t.rev, reason: 'The session will not go ahead.' }, maria.token);
  ok(cancel.status === 200 && cancel.body.trial.workflowState === 'cancelled', 'B9 the club MAY cancel while blocked — a minor must never be stranded with an unannounced trial (D-16)');
  const kn = await notifs('/player/notifications', kim.token);
  ok(kn.length === kimNotifsBefore + 1 && /cancelled the trial/.test(kn[0].text), 'B9b the cancellation notice reaches the family — operational safety, not solicitation');
  const report = await j('POST', `/org/trials/${TID}/report`, { technical: 3, tactical: 3, physical: 3, mental: 3, potential: 3, fit: 3, notes: 'Filed to close the obligation.' }, maria.token);
  ok(report.status === 201 || report.status === 400, `B10 the mandatory report can still be filed while blocked (${report.status})`);
  neg((await notifs('/player/notifications', kim.token)).length === kimNotifsBefore + 1, 'B10b but its player notification is suppressed while the block stands (D-16)');
  const famCancel = await j('POST', `/player/trials/${TID}/cancel`, {}, kim.token);
  ok(famCancel.status === 200 && famCancel.body.idempotent === true, 'B11 the player\'s own cancel of the already-cancelled trial is a replay, even while blocked');
  await unblock('pl-kim', 'org-eastport');
}

// =========================================================== K — rev + keys
section('K — expectedRev is an integer or nothing; idempotency keys are per action, per payload, per organisation');
const K = {};
{
  K.RID = await reviewed(maria.token, 'pl-mensah');
  const kwame = await playerLogin('pl-mensah');
  const inv = await invite(K.RID, maria.token, { clientKey: 'K-inv' });
  ok(inv.status === 201, 'K0 Kwame Mensah is invited');
  const p = await pendingTrial(kwame.token);
  const acc = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, kwame.token);
  K.TID = acc.body.trialId;
  const t = (await trialsOf(K.RID)).items.find((x) => x.id === K.TID);
  K.SID = t.schedule.sessions[0].id;
  const V = { name: 'Eastport Dome', town: 'Eastport' };
  const resched = (expectedRev, extra = {}) => j('POST', `/org/rooms/${K.RID}/trials/${K.TID}/reschedule`, { timezone: 'Europe/London', sessions: [{ id: K.SID, startsAt: T0 + 2 * H, endsAt: T0 + 4 * H, kind: 'drill', venue: V }], ...(expectedRev === undefined ? {} : { expectedRev }), ...extra }, maria.token);
  for (const [label, val] of [['missing', undefined], ['string "1"', '1'], ['float', 1.5], ['negative', -1], ['object', { toString: 1 }], ['array', [1]], ['boolean', true], ['empty string', ''], ['NaN string', 'one']]) {
    const r = collect(`rev ${label}`, await resched(val));
    neg(expect(r, 400, 'TRIAL_REV_REQUIRED'), `K1 expectedRev ${label} → 400 TRIAL_REV_REQUIRED (no coercion, never a 500)`);
  }
  const stale = collect('rev stale', await resched(t.rev + 5));
  neg(expect(stale, 409, 'TRIAL_VERSION_CONFLICT') && stale.body.currentRev === t.rev && stale.body.workflowState === 'scheduled', 'K2 a stale (or future) rev is a 409 that carries the current rev and state (the shared M18.1 conflict shape)');
  const good = await resched(t.rev, { clientKey: 'K-s1' });
  ok(good.status === 200 && good.body.trial.rev === t.rev + 1, 'K3 the exact rev is accepted and moves the rev by one');
  const replay = await resched(t.rev, { clientKey: 'K-s1' });
  ok(replay.status === 200 && replay.body.idempotent === true && replay.body.trial.rev === t.rev + 1, 'K4 the same key with the same payload is a replay — even though the rev it carries is now stale (the key answers first)');
  const different = collect('key payload conflict', await j('POST', `/org/rooms/${K.RID}/trials/${K.TID}/reschedule`, { timezone: 'Europe/London', expectedRev: t.rev + 1, clientKey: 'K-s1', sessions: [{ id: K.SID, startsAt: T0 + 2 * H, endsAt: T0 + 4 * H, kind: 'match', venue: V }] }, maria.token));
  neg(expect(different, 409, 'TRIAL_IDEMPOTENCY_CONFLICT'), 'K5 the same key with a different payload is a conflict');
  const afterConflict = (await trialsOf(K.RID)).items.find((x) => x.id === K.TID);
  neg(afterConflict.rev === t.rev + 1 && afterConflict.schedule.sessions[0].kind === 'drill', 'K5b and nothing was written by the conflict');
  for (const [label, key] of [['too long', 'k'.repeat(65)], ['numeric', 12], ['object', { k: 1 }], ['array', ['k']]]) {
    const r = collect(`key ${label}`, await resched(afterConflict.rev, { clientKey: key }));
    neg(expect(r, 400, 'TRIAL_CLIENT_KEY_INVALID'), `K6 a ${label} clientKey is refused before anything else`);
  }
  // The same key in another organisation is another key.
  const harbourRoom = await reviewed(rita.token, 'pl-mensah');
  const cross = await invite(harbourRoom, rita.token, { clientKey: 'K-inv' });
  ok(cross.status === 201 && cross.body.invitation.id !== inv.body.invitation.id, 'K7 the same clientKey used by another organisation collides with nothing (keys are scoped to the case)');
  const crossReplay = await invite(harbourRoom, rita.token, { clientKey: 'K-inv' });
  ok(crossReplay.status === 200 && crossReplay.body.idempotent === true && crossReplay.body.invitation.id === cross.body.invitation.id, 'K7b and replays only its own');
  // A cancel key, an attendance key and a completion key are separate namespaces.
  const cancelKeyed = collect('cancel with schedule key', await j('POST', `/org/rooms/${K.RID}/trials/${K.TID}/cancel`, { expectedRev: afterConflict.rev, reason: 'x', clientKey: 'K-s1' }, maria.token));
  ok(cancelKeyed.status === 200 && cancelKeyed.body.idempotent !== true && cancelKeyed.body.trial.workflowState === 'cancelled', 'K8 a key is per ACTION: the schedule key "K-s1" does not make the cancellation a replay');
  const cancelReplay = await j('POST', `/org/rooms/${K.RID}/trials/${K.TID}/cancel`, { expectedRev: 1, reason: 'x', clientKey: 'K-s1' }, maria.token);
  ok(cancelReplay.status === 200 && cancelReplay.body.idempotent === true, 'K8b replaying the cancellation with its key is a replay');
  const kwameNotifs = (await notifs('/player/notifications', kwame.token)).filter((n) => n.type === 'trial_day' && /cancelled/.test(n.text));
  ok(kwameNotifs.length === 1, 'K8c one cancellation notice reached the player, not two');
}

// ============================================================ C — concurrency
section('C — concurrency: two hands on the same record, one truth');
{
  const RID = await reviewed(maria.token, 'pl-tanaka');
  const riku = await playerLogin('pl-tanaka');
  // Two identical invitations in flight at once.
  const [i1, i2] = await Promise.all([invite(RID, maria.token, { clientKey: 'C-inv' }), invite(RID, maria.token, { clientKey: 'C-inv' })]);
  const statuses = [i1.status, i2.status].sort();
  ok(statuses.join(',') === '200,201' && i1.body.invitation.id === i2.body.invitation.id, 'C1 two identical invitations sent at once: one is created, the other is its replay — one request row');
  const p = await pendingTrial(riku.token);
  // Accept twice at once.
  const [a1, a2] = await Promise.all([
    j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, riku.token),
    j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.altSlots[0] }, riku.token),
  ]);
  const accStatuses = [a1.status, a2.status].sort();
  ok(accStatuses.join(',') === '200,409' && (await trialsOf(RID)).items.length === 1, 'C2 two acceptances at once: one trial, one ALREADY_RESPONDED');
  const TID = (await trialsOf(RID)).items[0].id;
  const t = (await trialsOf(RID)).items[0];
  const sid = t.schedule.sessions[0].id;
  const V = { name: 'Eastport Dome', town: 'Eastport' };
  // Reschedule vs attendance with the same rev.
  const [r1, r2] = await Promise.all([
    j('POST', `/org/rooms/${RID}/trials/${TID}/reschedule`, { timezone: 'Europe/London', expectedRev: t.rev, sessions: [{ id: sid, startsAt: t.schedule.sessions[0].startsAt, endsAt: t.schedule.sessions[0].endsAt, kind: 'match', venue: V }] }, maria.token),
    j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${sid}/attendance`, { state: 'attended', expectedRev: t.rev }, maria.token, at(t.schedule.sessions[0].startsAt + 10 * MIN)),
  ]);
  const rs = [r1.status, r2.status].sort();
  ok(rs.join(',') === '200,409' && [r1, r2].find((r) => r.status === 409).body.error === 'TRIAL_VERSION_CONFLICT', 'C3 reschedule vs attendance with the same rev: one wins, the other is a version conflict — nothing is applied twice');
  const t2 = (await trialsOf(RID)).items[0];
  ok(t2.rev === t.rev + 1, 'C3b exactly one rev was consumed');
  // Cancel vs complete with the same rev, once the session has ended and attendance exists.
  if (!t2.attendanceHistory.length) await j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${sid}/attendance`, { state: 'attended', expectedRev: t2.rev }, maria.token, at(t.schedule.sessions[0].startsAt + 10 * MIN));
  const t3 = (await trialsOf(RID)).items[0];
  const [c1, c2] = await Promise.all([
    j('POST', `/org/rooms/${RID}/trials/${TID}/cancel`, { expectedRev: t3.rev, reason: 'Called off.' }, maria.token, at(t.schedule.sessions[0].endsAt + H)),
    j('POST', `/org/rooms/${RID}/trials/${TID}/complete`, { expectedRev: t3.rev }, maria.token, at(t.schedule.sessions[0].endsAt + H)),
  ]);
  const cs = [c1.status, c2.status].sort();
  const t4 = (await trialsOf(RID)).items[0];
  ok(cs.join(',') === '200,409' && ['cancelled', 'completed'].includes(t4.workflowState) && t4.rev === t3.rev + 1, `C4 cancel vs complete with the same rev: one outcome (${t4.workflowState}), one version conflict, one rev`);
  neg(!(t4.completion.state === 'completed' && t4.completion.cancelledBy), 'C4b the record is not both cancelled and completed');
}

// ========================================================= F — transport failure
section('F — honest transport failure: nothing half-written, nothing sent');
{
  const RID = await reviewed(maria.token, 'pl-okafor');
  const chinedu = await playerLogin('pl-okafor');
  const outboxBefore = (await j('GET', '/admin/outbox', undefined, undefined, ADMIN)).body.length;
  const notifsBefore = (await notifs('/player/notifications', chinedu.token)).length;
  const histBefore = (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token)).body.history.total;
  const inj = await j('POST', '/admin/delivery/inject-failure', { channel: 'trial', count: 1 }, undefined, ADMIN);
  ok(inj.status === 200 && inj.body.injected.channel === 'trial', 'F0 the next Trial transport call is set to fail');
  const failed = collect('injected invite', await invite(RID, maria.token, { clientKey: 'F-inv' }));
  neg(expect(failed, 500, 'TRIAL_TRANSPORT_REFUSED'), 'F1 the invitation is refused honestly (500 TRIAL_TRANSPORT_REFUSED)');
  const after = await trialsOf(RID);
  neg(after.invitation === null && await stage(RID) === 'under_review' && (await pendingTrial(chinedu.token)) === null, 'F2 nothing was written: no request row, the case did not move, the player has nothing in the Inbox');
  neg((await notifs('/player/notifications', chinedu.token)).length === notifsBefore && (await j('GET', '/admin/outbox', undefined, undefined, ADMIN)).body.length === outboxBefore, 'F2b no notification, nothing queued to the outbox');
  neg((await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token)).body.history.total === histBefore, 'F2c and the case history has no entry for an invitation that never went');
  const retry = await invite(RID, maria.token, { clientKey: 'F-inv' });
  ok(retry.status === 201 && retry.body.case.to === 'trial_requested', 'F3 the retry with the same key succeeds — the failed attempt reserved nothing');
  // Acceptance.
  await j('POST', '/admin/delivery/inject-failure', { channel: 'trial', count: 1 }, undefined, ADMIN);
  const p = await pendingTrial(chinedu.token);
  const accFail = collect('injected accept', await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, chinedu.token));
  neg(expect(accFail, 500, 'TRIAL_TRANSPORT_REFUSED'), 'F4 the acceptance is refused at the transport');
  neg((await pendingTrial(chinedu.token))?.id === p.id && (await trialsOf(RID)).items.length === 0 && await stage(RID) === 'trial_requested', 'F5 the invitation is still pending, no trial exists, the case did not move (no D15 crash window)');
  const accRetry = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, chinedu.token);
  ok(accRetry.status === 200 && (await trialsOf(RID)).items.length === 1 && await stage(RID) === 'trial_scheduled', 'F6 the retried acceptance creates exactly one trial and moves the case');
  const TID = accRetry.body.trialId;
  const t = (await trialsOf(RID)).items[0];
  const sid = t.schedule.sessions[0].id;
  await j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${sid}/attendance`, { state: 'attended', expectedRev: t.rev }, maria.token, at(t.schedule.sessions[0].startsAt + 10 * MIN));
  await j('POST', '/admin/delivery/inject-failure', { channel: 'trial', count: 1 }, undefined, ADMIN);
  const compFail = collect('injected complete', await j('POST', `/org/rooms/${RID}/trials/${TID}/complete`, { expectedRev: t.rev + 1, clientKey: 'F-comp' }, maria.token, at(t.schedule.sessions[0].endsAt + H)));
  neg(expect(compFail, 500, 'TRIAL_TRANSPORT_REFUSED'), 'F7 the completion is refused at the transport');
  const t2 = (await trialsOf(RID)).items[0];
  neg(t2.workflowState === 'scheduled' && t2.completion === null && t2.rev === t.rev + 1 && await stage(RID) === 'trial_scheduled', 'F8 the trial is still scheduled, its rev unchanged, the case still trial_scheduled — no half-completion');
  const compRetry = await j('POST', `/org/rooms/${RID}/trials/${TID}/complete`, { expectedRev: t.rev + 1, clientKey: 'F-comp' }, maria.token, at(t.schedule.sessions[0].endsAt + H));
  ok(compRetry.status === 200 && compRetry.body.idempotent !== true && compRetry.body.case.to === 'trial_completed', 'F9 the retry completes it — the failed attempt did not record the key');
}

// ============================================================ E — Box Cam
section('E — Box Cam evidence by reference: consent, finality, refusal copy, withdrawal, unlinking');
const E = {};
{
  // Kola's completed trial (J) may still link evidence.
  const mk = async (token) => {
    const c = await j('POST', '/player/box-cam/sessions', { drillId: 'box-touches', target: { type: 'repetitions', value: 20 }, provider: 'production_cv' }, token);
    if (c.status !== 201) throw new Error(`box session: ${c.status} ${JSON.stringify(c.body)}`);
    const { session, nonce, livenessChallenge } = c.body;
    await j('POST', `/player/box-cam/sessions/${session.id}/start`, { nonce, liveness: livenessChallenge }, token);
    return { id: session.id, nonce };
  };
  const link = (boxSessionId, extra = {}) => j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/sessions/${J.SID}/evidence`, { boxSessionId, ...extra }, maria.token);
  const tv0 = await trial(J.RID, J.TID);
  let rev = tv0.trial.rev;
  E.OPEN = await mk(kola.token);
  await j('PATCH', '/player/box-cam/prefs', { shareDevelopmentActivity: 'private' }, kola.token);
  const noConsent = collect('no consent', await link(E.OPEN.id, { expectedRev: rev }));
  neg(expect(noConsent, 403, 'EVIDENCE_CONSENT_REQUIRED'), 'E1 a trial is not consent to the player\'s home footage: without the Combine consent rule, linking is refused (403 EVIDENCE_CONSENT_REQUIRED)');
  await j('PATCH', '/player/box-cam/prefs', { shareDevelopmentActivity: 'recruitment' }, kola.token);
  const notFinal = collect('not final', await link(E.OPEN.id, { expectedRev: rev }));
  neg(expect(notFinal, 409, 'EVIDENCE_NOT_FINAL'), 'E2 a session still recording cannot be cited (409 EVIDENCE_NOT_FINAL)');
  await j('POST', `/player/box-cam/sessions/${E.OPEN.id}/complete`, { nonce: E.OPEN.nonce }, kola.token);
  for (const [label, id] of [['unknown', 'bx-nope'], ['numeric', 12], ['object', { id: E.OPEN.id }], ['empty', '']]) {
    const r = collect(`ref ${label}`, await link(id, { expectedRev: rev }));
    neg(typeof id === 'string' && id ? expect(r, 404, 'TRIAL_BOXCAM_INCOMPATIBLE') : expect(r, 400, 'TRIAL_EVIDENCE_REF_INVALID'), `E3 a ${label} boxSessionId is refused (${r.status} ${r.body?.error})`);
  }
  const other = await mk(mateus.token);
  await j('POST', `/player/box-cam/sessions/${other.id}/complete`, { nonce: other.nonce }, mateus.token);
  const foreign = collect('other player session', await link(other.id, { expectedRev: rev }));
  neg(expect(foreign, 404, 'TRIAL_BOXCAM_INCOMPATIBLE'), 'E4 another player\'s session is "not available" — the club cannot tell it from a session that does not exist');
  const ghostSession = collect('ghost trial session', await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/sessions/tses-none/evidence`, { boxSessionId: E.OPEN.id, expectedRev: rev }, maria.token));
  neg(expect(ghostSession, 404, 'TRIAL_SESSION_NOT_FOUND'), 'E5 a trial session that does not exist cannot carry a link');
  const linked = await link(E.OPEN.id, { expectedRev: rev, clientKey: 'E-1' });
  ok(linked.status === 201 && linked.body.evidence.length === 1 && linked.body.trial.rev === rev + 1 && linked.body.trial.evidenceCount === 1, 'E6 a finalised session of the player, with consent, links by reference (201)');
  rev = linked.body.trial.rev;
  E.LINK = linked.body.evidence[0].id;
  const ev = linked.body.evidence[0];
  ok(ev.kind === 'box_cam_session' && ev.trialSessionId === J.SID && ev.session?.id === E.OPEN.id && ev.provenance === 'box_cam_observed' && ev.combineVerified === false && typeof ev.combineVerifiedBlockedBy === 'string', 'E7 the projection: kind, trial session, the referenced session, provenance, Combine Verified false with the platform reason');
  neg(!has(ev, 'trace') && !has(ev, 'nonce') && !has(ev, '"obs"') && !has(ev, 'confidence') && !has(ev, 'frames') && !has(ev, E.OPEN.nonce), 'E8 never trace[], nonce, obs.*, frames or a numeric confidence (N3/N4)');
  ok(ev.observation.state === 'no_cv_result' && /^No reliable observation available/.test(ev.observation.copy), 'E9 a session with no CV result projects "No reliable observation available" — a state, not a score');
  const again = await link(E.OPEN.id, { expectedRev: rev });
  ok(again.status === 200 && again.body.idempotent === true && again.body.evidence.length === 1, 'E10 linking the same session twice is a replay (D-12)');
  const replayKey = await link(E.OPEN.id, { expectedRev: 1, clientKey: 'E-1' });
  ok(replayKey.status === 200 && replayKey.body.idempotent === true, 'E10b and by key too');
  // A CV refusal.
  E.REFUSED = await mk(kola.token);
  const begun = await j('POST', `/player/box-cam/sessions/${E.REFUSED.id}/cv/begin`, { nonce: E.REFUSED.nonce, protocolId: 'combine-box-touch-60' }, kola.token);
  const fin = await j('POST', `/player/box-cam/sessions/${E.REFUSED.id}/cv/finalize`, { nonce: E.REFUSED.nonce, providerSessionId: begun.body?.providerSessionId }, kola.token);
  await j('POST', `/player/box-cam/sessions/${E.REFUSED.id}/complete`, { nonce: E.REFUSED.nonce }, kola.token);
  const linkedRefused = await link(E.REFUSED.id, { expectedRev: rev });
  rev = linkedRefused.body?.trial?.rev ?? rev;
  const evR = linkedRefused.body?.evidence?.find((e) => e.session?.id === E.REFUSED.id);
  ok(linkedRefused.status === 201 && !!evR && (fin.status !== 200 || fin.body.result?.outcome !== 'accepted'), `E11 a session the CV pipeline refused still links — it happened (${fin.status} ${fin.body?.result?.outcome ?? fin.body?.error ?? ''})`);
  ok(!!evR && /^No reliable observation available/.test(evR.observation.copy) && evR.observation.state !== 'accepted', `E12 the refusal projects as "No reliable observation available. …" under the refusal state (${evR?.observation?.state}) — never as poor performance (D-17)`);
  neg(!!evR && !/\b0\.\d+\b|\d+%|score|rating/i.test(JSON.stringify(evR.observation)), 'E12b the observation carries no confidence number, percentage, score or rating');
  // Withdrawn.
  E.CANCELLED = await mk(kola.token);
  await j('POST', `/player/box-cam/sessions/${E.CANCELLED.id}/cancel`, {}, kola.token);
  const withdrawn = collect('withdrawn', await link(E.CANCELLED.id, { expectedRev: rev }));
  neg(expect(withdrawn, 409, 'EVIDENCE_WITHDRAWN'), 'E13 a cancelled session cannot be cited (409 EVIDENCE_WITHDRAWN)');
  // Views.
  const tv = await trial(J.RID, J.TID);
  ok(tv.evidence.length === 2 && tv.trial.schedule.sessions[0].evidence.length === 2 && tv.trial.schedule.sessions[0].evidence.every((e) => Object.keys(e).sort().join(',') === 'id,kind,linkedAt,sessionId'), 'E14 the club view lists the links as ids; the projections carry the live provenance');
  const fam = (await j('GET', '/player/trials', undefined, kola.token)).body.find((x) => x.id === J.TID);
  neg(!has(fam, E.OPEN.id) && !has(fam, E.LINK) && !has(fam.workflow, 'evidence'), 'E15 the family view carries no evidence links — the player already owns the sessions in their own Box Cam record');
  const passport = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(!passport.timeline.some((e) => /trial_evidence|trial_observ|box.*trial/i.test(e.type)) && !has(passport, E.LINK), 'E16 the Passport gains no event from the link — referenced, not promoted (D-14)');
  const jr = (await j('GET', `/org/rooms/${J.RID}/journey?limit=200`, undefined, maria.token)).body;
  ok(jr.trials[0].workflow.evidenceCount === 2 && jr.trials[0].workflow.sessions[0].evidenceCount === 2 && jr.history.entries.filter((e) => e.kind === 'trial_evidence_linked').length === 2, 'E17 the journey counts the links and shows the link milestones (ids only)');
  neg(!has(jr, E.OPEN.nonce) && !has(jr, 'observation') && !has(jr, 'trace'), 'E17b and carries no observation');
  // Unlink.
  const unlinkGhost = collect('unlink ghost', await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/evidence/tev-none/unlink`, { expectedRev: rev }, maria.token));
  neg(expect(unlinkGhost, 404, 'TRIAL_SESSION_NOT_FOUND'), 'E18 unlinking a link that does not exist is a 404');
  const unlinked = await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/evidence/${E.LINK}/unlink`, { expectedRev: rev }, maria.token);
  ok(unlinked.status === 200 && unlinked.body.evidence.find((e) => e.id === E.LINK).removedAt > 0 && unlinked.body.trial.evidenceCount === 1, 'E19 unlinking tombstones the link (removedAt) — the row stays, the count drops');
  rev = unlinked.body.trial.rev;
  const unlinkTwice = await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/evidence/${E.LINK}/unlink`, { expectedRev: rev }, maria.token);
  ok(unlinkTwice.status === 200 && unlinkTwice.body.idempotent === true, 'E19b unlinking twice is a replay');
  const relink = await link(E.OPEN.id, { expectedRev: rev });
  ok(relink.status === 201 && relink.body.evidence.filter((e) => e.session?.id === E.OPEN.id).length === 2 && relink.body.trial.evidenceCount === 2, 'E20 relinking after an unlink creates a new link row; the old tombstone stays in the history');
  rev = relink.body.trial.rev;
  E.REV = rev;
  // Consent withdrawn after linking: the projection goes live.
  await j('PATCH', '/player/box-cam/prefs', { shareDevelopmentActivity: 'private' }, kola.token);
  const afterPrivate = await trial(J.RID, J.TID);
  ok(afterPrivate.evidence.length === 3, 'E21 withdrawing the sharing preference does not erase the link rows (history), and a new link would be refused');
  const newLinkPrivate = collect('link after private', await link(E.REFUSED.id, { expectedRev: rev }));
  neg(expect(newLinkPrivate, 403, 'EVIDENCE_CONSENT_REQUIRED'), 'E21b once consent is withdrawn even re-citing an already-linked session is refused — consent is evaluated NOW on every link, the existing rows are history');
  await j('PATCH', '/player/box-cam/prefs', { shareDevelopmentActivity: 'recruitment' }, kola.token);
}

// ============================================================ Q — assessments
section('Q — human assessment in Trial context: same store, same blind rule, same single door');
const Q = {};
{
  const ana = await login('org-eastport', 'Ana Ruiz', 'First-Team Scout');
  const create = (token, body) => j('POST', '/org/assessments', { playerId: 'pl-adeyemi', ...body }, token);
  for (const [label, ctx, status, code] of [
    ['other player\'s trial', { trialId: S.TID }, 404, 'TRIAL_NOT_FOUND'],
    ['unknown trial', { trialId: 'trial-none' }, 404, 'TRIAL_NOT_FOUND'],
    ['numeric trialId', { trialId: 42 }, 400, 'TRIAL_CONTEXT_INVALID'],
    ['session without trial', { trialSessionId: J.SID }, 400, 'TRIAL_CONTEXT_INVALID'],
    ['unknown session', { trialId: J.TID, trialSessionId: 'tses-none' }, 404, 'TRIAL_SESSION_NOT_FOUND'],
    ['object session', { trialId: J.TID, trialSessionId: { id: J.SID } }, 400, 'TRIAL_CONTEXT_INVALID'],
  ]) neg(expect(collect(`assess ${label}`, await create(tom.token, { context: ctx })), status, code), `Q1 an assessment with ${label} is refused (${status} ${code})`);
  const tomA = await create(tom.token, { context: { trialId: J.TID, trialSessionId: J.SID, viewing: 'live' } });
  ok(tomA.status === 201 && tomA.body.assessment.context.trialId === J.TID && tomA.body.assessment.context.trialSessionId === J.SID && tomA.body.assessment.state === 'draft', 'Q2 a contributor (trial_assess) opens an assessment in the context of the trial and its session');
  Q.TOM = tomA.body.assessment.id;
  const attr = tomA.body.assessment.attributesSnapshot[0].id;
  const rated = await j('PUT', `/org/assessments/${Q.TOM}`, { ratings: [{ attrId: attr, rating: 4, confidence: 'high', note: S_ASSESS, evidenceRefs: [{ trialSessionId: J.SID }, { boxSessionId: E.OPEN.id }] }], recommendation: { verdict: 'monitor', reasons: `${S_ASSESS} — needs a second look.` } }, tom.token);
  ok(rated.status === 200 && rated.body.assessment.ratings[0].evidenceRefs.length === 2, 'Q3 a rating may cite the trial session and a Box Cam session LINKED to the trial — by reference');
  const unlinkedRef = collect('unlinked ref', await j('PUT', `/org/assessments/${Q.TOM}`, { ratings: [{ attrId: attr, rating: 4, evidenceRefs: [{ boxSessionId: E.CANCELLED.id }] }] }, tom.token));
  neg(expect(unlinkedRef, 400, 'TRIAL_EVIDENCE_REF_INVALID'), 'Q4 a Box Cam session NOT linked to the trial cannot be cited');
  const badSessRef = collect('bad session ref', await j('PUT', `/org/assessments/${Q.TOM}`, { ratings: [{ attrId: attr, rating: 4, evidenceRefs: [{ trialSessionId: 'tses-none' }] }] }, tom.token));
  neg(expect(badSessRef, 400, 'TRIAL_EVIDENCE_REF_INVALID'), 'Q4b nor a trial session that is not on the trial');
  const repoint = collect('repoint', await j('PUT', `/org/assessments/${Q.TOM}`, { context: { trialId: S.TID } }, tom.token));
  neg(expect(repoint, 409, 'TRIAL_CONTEXT_IMMUTABLE'), 'Q5 the trial an assessment belongs to cannot be changed after creation');
  const repointSession = collect('repoint session', await j('PUT', `/org/assessments/${Q.TOM}`, { context: { trialSessionId: null } }, tom.token));
  neg(expect(repointSession, 409, 'TRIAL_CONTEXT_IMMUTABLE'), 'Q5b nor its session');
  const sameCtx = await j('PUT', `/org/assessments/${Q.TOM}`, { context: { trialId: J.TID, trialSessionId: J.SID, minutesWatched: 90 } }, tom.token);
  ok(sameCtx.status === 200 && sameCtx.body.assessment.context.minutesWatched === 90 && sameCtx.body.assessment.context.trialId === J.TID, 'Q5c restating the same context with an ordinary field is fine');
  // The blind rule through the trial door.
  const anaSees = (await j('GET', `/org/assessments?trialId=${J.TID}`, undefined, ana.token)).body;
  const anaList = anaSees.items ?? anaSees;
  neg(Array.isArray(anaList) && anaList.length === 0, 'Q6 another scout sees nothing of Tom\'s draft through ?trialId= (blind rule)');
  const leadSees = (await j('GET', `/org/assessments?trialId=${J.TID}`, undefined, maria.token)).body;
  ok((leadSees.items ?? leadSees).length === 1, 'Q6b the lead sees it');
  const badTrialQuery = collect('bad trialId query', await j('GET', '/org/assessments?trialId=trial-none', undefined, maria.token));
  neg(expect(badTrialQuery, 404, 'TRIAL_NOT_FOUND'), 'Q6c an unknown trialId query is a 404, not an empty list');
  const anaA = await create(ana.token, { context: { trialId: J.TID } });
  ok(anaA.status === 201, 'Q7 a second assessor opens her own — multiple assessors per trial');
  Q.ANA = anaA.body.assessment.id;
  const tvA = await trial(J.RID, J.TID, ana.token);
  neg(tvA.assessments.length === 1 && tvA.assessments[0].id === Q.ANA, 'Q8 on the trial page Ana sees only her own until she submits');
  const tvL = await trial(J.RID, J.TID, maria.token);
  ok(tvL.assessments.length === 2 && tvL.assessments.every((a) => Object.keys(a).sort().join(',') === 'id,published,scoutName,scoutUserId,state,submittedAt,trialSessionId'), 'Q9 the trial page lists assessments as EXISTENCE and state — never ratings, notes or a recommendation');
  neg(!has(tvL, S_ASSESS) && !has(tvL, 'monitor'), 'Q9b the sentinel and the verdict are not on the trial page');
  const submitted = await j('POST', `/org/assessments/${Q.TOM}/submit`, {}, tom.token);
  ok(submitted.status === 200 && submitted.body.assessment.state === 'submitted', 'Q10 Tom submits');
  const jr = (await j('GET', `/org/rooms/${J.RID}/journey?limit=200`, undefined, maria.token)).body;
  const milestone = jr.history.entries.filter((e) => e.kind === 'trial_assessment_recorded');
  ok(milestone.length >= 1 && milestone.every((e) => e.trialId === J.TID && e.assessmentId && !has(e, S_ASSESS)), 'Q11 the journey records that an assessment exists for the trial — id and state only');
  neg(!has(jr, S_ASSESS) && !has(jr, 'monitor'), 'Q11b the journey never carries assessment content');
  const compare = await j('GET', `/org/players/pl-adeyemi/assessment-compare`, undefined, maria.token);
  ok(compare.status === 200 && compare.body.assessments.some((a) => a.id === Q.TOM && a.context?.trialId === J.TID), 'Q12 the existing compare view carries the trial context beside the assessment (no new compare surface)');
  const stage2 = await stage(J.RID);
  ok(stage2 === 'trial_completed', 'Q13 submitting an assessment moves no case — an assessment is not a decision');
}

// ============================================================ I — sentinels
section('I — sentinels: club-private text never reaches the family, the events, the outbox, the Passport or another club');
{
  // A club note on attendance, an assessment (Q), and the family's emergency contact.
  const tS = (await trialsOf(S.RID)).items.find((x) => x.id === S.TID);
  const ended = tS.schedule.sessions[0];
  const sse = await sseCollect(mateus.token, 1200);
  const sseOrg = await sseCollect(maria.token, 1200);
  const noted = await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/sessions/${ended.id}/attendance`, { state: 'attended', expectedRev: tS.rev, note: S_NOTE }, maria.token, at(ended.startsAt + 5 * MIN));
  ok(noted.status === 200, 'I0 a club note is recorded on Mateus\'s attendance');
  const emerg = await j('POST', `/player/trials/${S.TID}/emergency-contact`, { name: S_EMERG, phone: '07700900000' }, mateus.token);
  ok(emerg.status === 200, 'I0b the family sets an emergency contact');
  const playerFrames = await sse.stop(); const orgFrames = await sseOrg.stop();
  const surfaces = {
    'player trials': (await j('GET', '/player/trials', undefined, mateus.token)).body,
    'player notifications': await notifs('/player/notifications', mateus.token),
    'player inbox': (await j('GET', '/player/inbox', undefined, mateus.token)).body,
    'player passport': (await j('GET', '/player/football-passport', undefined, mateus.token)).body,
    'player safety pack': (await j('GET', `/player/trials/${S.TID}/safety-pack`, undefined, mateus.token)).body,
    'kola passport': (await j('GET', '/player/football-passport', undefined, kola.token)).body,
    'kola trials': (await j('GET', '/player/trials', undefined, kola.token)).body,
    'kola notifications': await notifs('/player/notifications', kola.token),
    'guardian trials': (await j('GET', '/guardian/trials', undefined, amara.token)).body,
    'guardian notifications': await notifs('/guardian/notifications', amara.token),
    'org notifications': await notifs('/org/notifications', maria.token),
    'journey (S)': (await j('GET', `/org/rooms/${S.RID}/journey?limit=200`, undefined, maria.token)).body,
    'journey (J)': (await j('GET', `/org/rooms/${J.RID}/journey?limit=200`, undefined, maria.token)).body,
    'audit': (await j('GET', '/org/audit?limit=50', undefined, maria.token)).body,
    'outbox': (await j('GET', '/admin/outbox', undefined, undefined, ADMIN)).body,
    'push log': (await j('GET', '/admin/push-log', undefined, undefined, ADMIN)).body,
    'analytics': (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body,
    'other org rooms': (await j('GET', '/org/rooms', undefined, rita.token)).body,
    'player SSE': playerFrames,
    'org SSE': orgFrames,
    'org trial view (emergency)': (await trial(S.RID, S.TID)).trial,
    'org trials list': (await trialsOf(S.RID)).items,
  };
  for (const [name, body] of Object.entries(surfaces)) {
    const clubPrivate = ['player', 'guardian', 'journey', 'audit', 'outbox', 'push', 'analytics', 'other org', 'SSE', 'kola'].some((k) => name.includes(k));
    if (clubPrivate) neg(!has(body, S_ASSESS) && !has(body, S_NOTE), `I1 ${name}: no assessment sentinel, no attendance-note sentinel`);
    if (!name.startsWith('player')) neg(!has(body, S_EMERG) && !has(body, '07700900000'), `I2 ${name}: no family emergency-contact sentinel`);
  }
  const dayView = await j('GET', `/org/trials/${S.TID}/day`, undefined, maria.token);
  ok(dayView.status !== 200 || has(dayView.body, S_EMERG) || dayView.body?.emergency === null || dayView.body?.trial?.day?.emergency !== undefined, 'I3 the emergency contact lives in the trial-day view only (existing P2 rule), not on the workflow record');
  neg(!/PRIVATE_/.test(orgFrames) && !/PRIVATE_/.test(playerFrames), 'I4 no SSE frame on either side carries any sentinel — events are ids only');
}

// ============================================================ N — notifications, audit, journey
section('N — notifications honour preferences and routing; the audit log and the journey carry the process');
{
  // Own-property preference: the player turns trial updates off; a proposal creates nothing for them.
  const tS = (await trialsOf(S.RID)).items.find((x) => x.id === S.TID);
  const pref = await j('PUT', '/player/notification-preferences', { categories: { trial_updates: false } }, mateus.token);
  ok(pref.status === 200, 'N0 Mateus turns trial updates off');
  const before = (await notifs('/player/notifications', mateus.token)).length;
  const keep = tS.schedule.sessions.map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, venue: { name: 'Eastport Dome', town: 'Eastport' }, instructions: 'Wear the bib you were given.' }));
  const re = await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, { timezone: 'Europe/London', expectedRev: tS.rev, sessions: keep }, maria.token, at(tS.schedule.sessions[0].startsAt + 5 * MIN));
  ok(re.status === 200 && re.body.material === false, 'N1 a cosmetic revision goes out');
  neg((await notifs('/player/notifications', mateus.token)).length === before, 'N2 no notification was CREATED for a category the player turned off (D10: not hidden, not created)');
  const protoPref = collect('proto pref', await j('PUT', '/player/notification-preferences', { categories: { __proto__: { trial_updates: true }, constructor: false } }, mateus.token));
  ok(protoPref.status === 200 || protoPref.status === 400, 'N2b prototype keys in preferences are not categories');
  await j('PUT', '/player/notification-preferences', { categories: { trial_updates: true } }, mateus.token);
  // Audit: leads only, domain recruitment_trial, ids and states.
  const audit = (await j('GET', '/org/audit?limit=50', undefined, maria.token)).body;
  const rows = audit.items.filter((r) => r.domain === 'recruitment_trial');
  ok(rows.length >= 8 && rows.every((r) => r.target.type === 'trial' && typeof r.at === 'number'), `N3 ${rows.length} recruitment_trial audit rows, each targeting a trial`);
  const actions = new Set(rows.map((r) => r.action));
  ok(['trial_accepted', 'trial_schedule_confirmed', 'trial_attendance_recorded', 'trial_completed', 'trial_cancelled', 'trial_rescheduled', 'trial_evidence_linked'].every((a) => actions.has(a)), 'N3b the operational actions are all there');
  neg(rows.every((r) => !r.detail || Object.values(r.detail).every((v) => typeof v !== 'string' || v.length < 40)), 'N3c no audit detail carries free text');
  neg(rows.filter((r) => r.action === 'trial_attendance_recorded').every((r) => r.detail?.state && !('note' in (r.detail ?? {}))), 'N3d an attendance row carries the state, never the note');
  const tomAudit = collect('tom audit', await j('GET', '/org/audit', undefined, tom.token));
  neg(tomAudit.status === 403, 'N4 a contributor cannot read the audit log');
  // Journey milestones and shared records.
  const jr = (await j('GET', `/org/rooms/${J.RID}/journey?limit=200`, undefined, maria.token)).body;
  const kinds = jr.history.entries.map((e) => e.kind);
  ok(['trial_invited', 'trial_accepted', 'trial_schedule_confirmed', 'trial_attendance_recorded', 'trial_completed', 'room_status_changed'].every((k) => kinds.includes(k)), 'N5 the journey timeline carries the trial milestones beside the case transitions');
  const invited = jr.history.entries.find((e) => e.kind === 'trial_invited');
  ok(invited.requestId === J.REQ && invited.recipientType === 'player' && !has(invited, 'Come and train'), 'N5b the invitation milestone is ids and the recipient type, not the message');
  ok(jr.trials.length === 1 && jr.trials[0].workflow.workflowState === 'completed' && jr.trials[0].workflow.sessions[0].attendance === 'attended' && jr.trials[0].status === 'awaiting_report', 'N6 the journey trial milestone: state, session attendance, and the untouched report status');
  ok(jr.conditions.trialActive === false && (await j('GET', `/org/rooms/${S.RID}/journey`, undefined, maria.token)).body.conditions.trialActive === true, 'N6b trialActive is derived as before: a scheduled case with a report owed is active, a completed case is not');
  const declinedRoom = await reviewed(maria.token, 'pl-martin');
  const theo = await playerLogin('pl-martin');
  await invite(declinedRoom);
  const pd = await pendingTrial(theo.token);
  await j('POST', `/player/requests/${pd.id}/respond`, { accept: false }, theo.token);
  const jrD = (await j('GET', `/org/rooms/${declinedRoom}/journey?limit=50`, undefined, maria.token)).body;
  ok(jrD.history.entries.some((e) => e.kind === 'trial_declined' && e.requestId === pd.id) && jrD.trials.length === 0, 'N7 a declined invitation is a milestone with no trial');
  ok(jrD.lifecycle.currentStage === 'trial_requested', 'N7b the case stays at trial_requested — a decline is a fact, not a regression; the club decides what next');
  const leadN = (await notifs('/org/notifications', maria.token)).filter((n) => n.type === 'trial_day');
  ok(leadN.some((n) => /confirmed the trial schedule/.test(n.text)) && leadN.some((n) => /declined the proposed trial schedule/.test(n.text)), 'N8 the club lead was told about confirmations and declines (trial_day)');
}

const X_STATE = {};
// ============================================================ X — content
section('X — content: text is text, prototype keys are nothing, wrong types are refused, ICS escapes');
{
  const RID = await reviewed(maria.token, 'pl-alvarez');
  const santi = await playerLogin('pl-alvarez');
  // A fixed daytime anchor two days ahead, so "the same London day" does not depend on the wall clock.
  const D = new Date(); const ANCHOR = Date.UTC(D.getUTCFullYear(), D.getUTCMonth(), D.getUTCDate() + 2, 10, 0, 0);
  for (const [label, extra, code] of [
    ['slots as a string', { slots: 'tomorrow' }, 'TRIAL_SLOTS_INVALID'],
    ['slots as an object', { slots: { startsAt: 1 } }, 'TRIAL_SLOTS_INVALID'],
    ['four slots', { slots: [0, 1, 2, 3].map((i) => ({ startsAt: T0 + (2 + 24 * i) * H, endsAt: T0 + (4 + 24 * i) * H })) }, 'TRIAL_SLOTS_INVALID'],
    ['two slots on one day', { slots: [{ startsAt: ANCHOR, endsAt: ANCHOR + H }, { startsAt: ANCHOR + 2 * H, endsAt: ANCHOR + 3 * H }] }, 'TRIAL_SLOTS_INVALID'],
    ['a slot in the past', { slots: [{ startsAt: T0 - 5 * H, endsAt: T0 - 3 * H }] }, 'TRIAL_SCHEDULE_INVALID'],
    ['a slot without a zone-bearing instant', { slots: [{ startsAt: '2026-12-01T10:00:00', endsAt: '2026-12-01T12:00:00' }] }, 'TRIAL_SCHEDULE_INVALID'],
    ['venue as a string', { venue: 'Eastport Dome' }, 'TRIAL_VENUE_INVALID'],
    ['venue without a name', { venue: { town: 'Eastport' } }, 'TRIAL_VENUE_INVALID'],
    ['message as a number', { message: 42 }, 'TRIAL_CONTENT_INVALID'],
    ['empty message', { message: '   ' }, 'TRIAL_CONTENT_INVALID'],
    ['over-long message', { message: 'x'.repeat(TRIAL_LIMITS.message + 1) }, 'TRIAL_CONTENT_INVALID'],
    ['instructions as a list', { instructions: ['a'] }, 'TRIAL_CONTENT_INVALID'],
    ['timezone as a number', { timezone: 0 }, 'TRIAL_TIMEZONE_INVALID'],
    ['timezone offset', { timezone: '+01:00' }, 'TRIAL_TIMEZONE_INVALID'],
  ]) neg(expect(collect(`content ${label}`, await invite(RID, maria.token, extra)), 400, code), `X1 ${label} → 400 ${code}`);
  const arrayBody = collect('array body', await j('POST', `/org/rooms/${RID}/trials`, [1, 2], maria.token));
  neg(arrayBody.status === 400, 'X1b a JSON array body is refused (400)');
  neg((await trialsOf(RID)).invitation === null, 'X2 none of those wrote an invitation');
  const xss = `<script>alert(1)</script> Come and train "with" us & bring boots; see you, then.`;
  const inv = await invite(RID, maria.token, { message: xss, instructions: 'Line one\nLine two, with a comma; and a semicolon', __proto__: { admin: true }, constructor: { prototype: { polluted: true } } });
  ok(inv.status === 201, 'X3 a message with markup and punctuation is accepted as TEXT; prototype keys are ignored');
  ok(({}).polluted === undefined && ({}).admin === undefined, 'X3b the suite\'s own prototype is untouched (and the server answered normally)');
  const p = await pendingTrial(santi.token);
  ok(p.message === xss, 'X4 the recipient receives the exact text — the API never renders it');
  const acc = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, santi.token);
  const TID = acc.body.trialId;
  const ics = (await raw(`/org/trials/${TID}/ics`, maria.token)).text;
  ok(ics.includes('DESCRIPTION:Line one\\nLine two\\, with a comma\\; and a semicolon') && !ics.includes('\nLine two'), 'X5 the ICS description escapes the line break, the comma and the semicolon — no injected calendar line');
  const cancelBad = collect('cancel reason number', await j('POST', `/org/rooms/${RID}/trials/${TID}/cancel`, { expectedRev: 1, reason: 12 }, maria.token));
  neg(expect(cancelBad, 400, 'TRIAL_CONTENT_INVALID') && cancelBad.body.field === 'reason', 'X6 a cancellation reason must be text');
  const cancelLong = collect('cancel reason long', await j('POST', `/org/rooms/${RID}/trials/${TID}/cancel`, { expectedRev: 1, reason: 'x'.repeat(TRIAL_LIMITS.reason + 1) }, maria.token));
  neg(expect(cancelLong, 400, 'TRIAL_CONTENT_INVALID'), 'X6b and bounded');
  const unicode = await j('POST', `/org/rooms/${RID}/trials/${TID}/reschedule`, { timezone: 'Europe/London', expectedRev: 1, sessions: [{ startsAt: T0 + 50 * H, endsAt: T0 + 52 * H, venue: { name: 'Stade Émile-Zola — «Nord»', town: 'Saint-Étienne' }, instructions: '¡Trae botas! 靴を持ってきて 🙂' }] }, maria.token);
  ok(unicode.status === 200 && unicode.body.trial.schedule.sessions[0].venue.name === 'Stade Émile-Zola — «Nord»' && unicode.body.trial.schedule.sessions[0].instructions.includes('🙂'), 'X7 Unicode venue names and instructions round-trip intact');
  const jsonErrors = ERROR_BODIES.filter((e) => e.status >= 500 && e.body?.error !== 'TRIAL_TRANSPORT_REFUSED');
  neg(jsonErrors.length === 0, `X8 no refusal in this suite was an unexplained 500 (${jsonErrors.length})`);
  neg(ERROR_BODIES.every((e) => e.body && typeof e.body.error === 'string'), 'X9 every refusal is JSON with a string error code');
  neg(!ERROR_BODIES.some((e) => /at .*\.mjs:\d+|node_modules|stack/i.test(JSON.stringify(e.body))), 'X9b no refusal body carries a stack trace or a file path');
  const T = { RID, TID, santi };
  Object.assign(X_STATE, T);
}

// ============================================================ T — tombstone
section('T — the subject removed their account: the trial stays on record as ids, states and times; nothing more is written');
{
  const { RID, TID, santi } = X_STATE;
  const t0 = await trial(RID, TID);
  ok(t0.trial.playerName === 'Santiago Álvarez' && t0.trial.schedule.sessions[0].instructions !== null, 'T0 before removal: the club view carries the name and the instructions');
  const del = await j('DELETE', '/player/account', undefined, santi.token);
  ok(del.status === 200 && del.body.deleted === true, 'T1 the player removes their account');
  const t1 = await trial(RID, TID);
  ok(t1.trial.subjectRemovedAt > 0 && t1.trial.playerName === null && t1.trial.workflowState === 'accepted', 'T2 the trial is tombstoned: no name, the state as it was');
  neg(t1.trial.schedule.sessions.every((s) => s.instructions === null && (s.venue?.address ?? null) === null && s.evidence.length === 0) && t1.trial.history.every((h) => !h.detail || Object.values(h.detail).every((v) => typeof v !== 'string' || v.length < 40)), 'T3 instructions, address lines, evidence links and long history detail are gone; ids, states and times remain');
  neg(!has(t1, '🙂') && !has(t1, 'alert(1)'), 'T3b nothing the club wrote for the person survives on the row');
  const V = { name: 'Eastport Dome', town: 'Eastport' };
  for (const [label, r] of [
    ['reschedule', await j('POST', `/org/rooms/${RID}/trials/${TID}/reschedule`, { timezone: 'Europe/London', expectedRev: t1.trial.rev, sessions: [{ startsAt: T0 + 70 * H, endsAt: T0 + 72 * H, venue: V }] }, maria.token)],
    ['cancel', await j('POST', `/org/rooms/${RID}/trials/${TID}/cancel`, { expectedRev: t1.trial.rev, reason: 'x' }, maria.token)],
    ['attendance', await j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${t1.trial.schedule.sessions[0].id}/attendance`, { state: 'attended', expectedRev: t1.trial.rev }, maria.token, at(T0 + 51 * H))],
    ['complete', await j('POST', `/org/rooms/${RID}/trials/${TID}/complete`, { expectedRev: t1.trial.rev }, maria.token, at(T0 + 60 * H))],
    ['link', await j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${t1.trial.schedule.sessions[0].id}/evidence`, { boxSessionId: 'x', expectedRev: t1.trial.rev }, maria.token)],
  ]) neg(expect(collect(`tombstone ${label}`, r), 409, 'TRIAL_SUBJECT_REMOVED'), `T4 ${label} on a tombstoned trial → 409 TRIAL_SUBJECT_REMOVED`);
  const assess = collect('tombstone assess', await j('POST', '/org/assessments', { playerId: 'pl-alvarez', context: { trialId: TID } }, maria.token));
  neg(assess.status === 404 || expect(assess, 409, 'TRIAL_SUBJECT_REMOVED'), `T5 no assessment can be opened about a person who left (${assess.status})`);
  const report = collect('tombstone report', await j('POST', `/org/trials/${TID}/report`, { notes: 'x' }, maria.token));
  neg(expect(report, 409, 'TRIAL_SUBJECT_REMOVED'), 'T6 the legacy report route refuses too (P4A-D14, unchanged)');
  const ics = await raw(`/org/trials/${TID}/ics`, maria.token);
  ok(ics.status === 200 && ics.text.includes('removed player') && !ics.text.includes('Álvarez'), 'T7 the calendar export still works and names nobody');
  const jr = (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token)).body;
  ok(jr.trials.length === 1 && jr.trials[0].workflow.workflowState === 'accepted' && jr.history.entries.some((e) => e.kind === 'trial_accepted'), 'T8 the journey still shows what happened');
  const audit = (await j('GET', '/org/audit?limit=50', undefined, maria.token)).body;
  ok(audit.items.some((r) => r.domain === 'recruitment_trial' && r.target.id === TID && r.target.playerName === null), 'T9 the audit rows remain, with the subject unnamed');
  const list = await trialsOf(RID);
  ok(list.items.some((x) => x.id === TID && x.subjectRemovedAt > 0) && list.routing.available === false, 'T10 the room lists the tombstoned trial and says the recipient is unavailable');
}

// ============================================================ L — rate limits
section('L — rate limits are server-enforced per policy scope');
{
  const RID = await reviewed(rita.token, 'pl-nowak');
  const filip = await playerLogin('pl-nowak');
  const inv = await invite(RID, rita.token, { slots: [{ startsAt: T0 + 500 * H, endsAt: T0 + 502 * H }] });
  ok(inv.status === 201, 'L0 Harbour invites Filip Nowak');
  const p = await pendingTrial(filip.token);
  const acc = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, filip.token);
  const TID = acc.body.trialId;
  let t = (await trialsOf(RID, rita.token)).items.find((x) => x.id === TID);
  const sid = t.schedule.sessions[0].id;
  let limitedAt = -1; let last = null;
  for (let i = 0; i < RATE_LIMIT_POLICY.trial_schedule.max + 5; i += 1) {
    const r = await j('POST', `/org/rooms/${RID}/trials/${TID}/reschedule`, { timezone: 'Europe/London', expectedRev: t.rev, sessions: [{ id: sid, startsAt: T0 + 500 * H, endsAt: T0 + 502 * H, venue: { name: 'Harbour Ground', town: 'Harbour' }, instructions: `Revision ${i}` }] }, rita.token);
    if (r.status === 429) { limitedAt = i; last = r; break; }
    if (r.status !== 200) { last = r; break; }
    t = r.body.trial;
  }
  if (limitedAt < 0) console.error('   L1 stopped by', last?.status, JSON.stringify(last?.body).slice(0, 200));
  const capped = last?.status === 409 && last.body?.error === 'TRIAL_INVALID_STATE' && /revised at most/.test(last.body.message ?? '');
  neg((limitedAt > 0 && last?.body?.error === 'RATE_LIMITED' && last.body.action === 'trial_schedule') || capped, `L1 the org-scoped schedule policy (or the revision cap, whichever is lower) stops the loop (${last?.status} ${last?.body?.error})`);
  neg(t.revisions.length <= TRIAL_LIMITS.revisions, `L1b the record never grows without bound (${t.revisions.length} revisions, cap ${TRIAL_LIMITS.revisions})`);
  const eastportStill = await j('POST', `/org/rooms/${S.RID}/trials/${S.TID}/reschedule`, { timezone: 'Europe/London', expectedRev: 0, sessions: [] }, maria.token);
  neg(eastportStill.status !== 429, 'L2 Harbour\'s limit is Harbour\'s — Eastport is not limited by it (scope: org)');
  const recipientBurst = [];
  for (let i = 0; i < 3; i += 1) recipientBurst.push((await j('POST', `/player/trials/${TID}/decline-schedule`, {}, filip.token)).status);
  ok(recipientBurst.every((s) => s === 200), 'L3 a recipient\'s ordinary replays are not limited (replays answer before the limiter)');
  // The invitation policy (30/h per organisation): invite, decline, step the
  // test clock past the cooldown, invite again — the limiter keeps its own
  // real clock, so the 31st invitation in the hour is refused.
  const RID2 = await reviewed(rita.token, 'pl-okafor');
  const chinedu = await playerLogin('pl-okafor');
  let tripped = null; let sent = 0;
  for (let i = 1; i <= RATE_LIMIT_POLICY.trial_invite.max + 2; i += 1) {
    const clock = T0 + i * 80 * H;
    const r = await invite(RID2, rita.token, { slots: SLOTS(clock) }, at(clock));
    if (r.status === 429) { tripped = r; break; }
    if (r.status !== 201) { tripped = r; break; }
    sent += 1;
    const pend = await pendingTrial(chinedu.token);
    await j('POST', `/player/requests/${pend.id}/respond`, { accept: false }, chinedu.token);
  }
  neg(tripped?.status === 429 && tripped.body.error === 'RATE_LIMITED' && tripped.body.action === 'trial_invite' && sent >= RATE_LIMIT_POLICY.trial_invite.max - 2, `L4 the invitation policy trips after ${sent} invitations in the window (429 RATE_LIMITED trial_invite)`);
  const eastportInvite = await invite(await reviewed(maria.token, 'pl-imani'), maria.token, { slots: SLOTS(T0 + 900 * H) }, at(T0 + 900 * H));
  neg(eastportInvite.status !== 429, `L4b Eastport is not limited by Harbour's burst (${eastportInvite.status})`);
}

// ================================================================ Z — restart
section('Z — restart: keys, links and truth survive the process dying');
{
  server.kill('SIGKILL');
  for (let i = 0; i < 40; i += 1) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { break; } }
  server = await boot();
  const re = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  ok(!!re?.token, 'Z1 the server came back');
  const health = (await j('GET', '/healthz')).body;
  ok(health.schemaVersion === SCHEMA_VERSION, `Z2 schema ${SCHEMA_VERSION} after the restart`);
  const inv = await invite(J.RID, re.token, { clientKey: 'J-inv' });
  neg(inv.status === 200 && inv.body.idempotent === true && inv.body.invitation.id === J.REQ, 'Z3 the invitation key still replays — it lives on the request row, not in memory');
  const comp = await j('POST', `/org/rooms/${J.RID}/trials/${J.TID}/complete`, { expectedRev: 1, clientKey: 'J-comp' }, re.token);
  neg(comp.status === 200 && comp.body.idempotent === true, 'Z4 the completion key still replays');
  const tv = await trial(J.RID, J.TID, re.token);
  ok(tv.trial.workflowState === 'completed' && tv.trial.rev === E.REV && tv.evidence.length === 3 && tv.evidence.filter((e) => e.removedAt).length === 1 && tv.assessments.length === 2, 'Z5 the completed trial, its rev, its three link rows (one tombstoned) and its two assessments are exactly as before');
  const tS = (await trialsOf(S.RID, re.token)).items.find((x) => x.id === S.TID);
  ok(tS.workflowState === 'scheduled' && tS.schedule.sessions.length === 20 && tS.attendanceHistory.some((a) => a.note === S_NOTE), 'Z6 the twenty-session trial is still scheduled with its attendance note');
  const att = await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/sessions/${A.SID}/attendance`, { state: 'attended', expectedRev: 999, clientKey: 'A-2', note: 'Arrived late, the gate was locked.' }, re.token);
  neg(att.status === 200 && att.body.idempotent === true, 'Z7 an attendance key replays after the restart');
  const kolaAgain = await playerLogin('pl-adeyemi');
  const fam = (await j('GET', '/player/trials', undefined, kolaAgain.token)).body.find((x) => x.id === J.TID);
  ok(fam?.workflow?.workflowState === 'completed', 'Z8 the player still sees their completed trial');
  ok(await stage(J.RID, re.token) === 'trial_completed' && await stage(S.RID, re.token) === 'trial_scheduled', 'Z9 the case stages are durable');
}

// ---------------------------------------------------------------- report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nM23 P4B Trial suite: ${total} checks passed, ${negatives} negative/security/safeguarding checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P4B Trial has failures.');
else console.log('all M23 P4B Trial checks passed');
process.exit(process.exitCode ?? 0);
