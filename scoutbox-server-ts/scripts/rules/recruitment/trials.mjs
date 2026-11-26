// The Trial engine behind the Trial battery (e2e/recruitment/trials.mjs), checked in this process: timezones and
// instants, schedules, workflow states, gates and views (U), and the policy tables — error bands, rate policies, the
// event registry, the migration, evidence and the Room's gates (P).
import {
  TRIAL_WORKFLOW_STATES,
  TRIAL_SESSION_KINDS,
  TRIAL_ATTENDANCE_STATES,
  TRIAL_LIMITS,
  TRIAL_WORKFLOW_LABELS,
  validateTimezone,
  parseInstant,
  localDay,
  icsLocal,
  icsText,
  validateVenue,
  validateSessionInput,
  validateScheduleInput,
  materialChange,
  deriveWorkflowState,
  isLegacyTrial,
  currentAttendance,
  canComplete,
  trialStateAllows,
  blockedAllows,
  trialIntegrity,
  trialClubView,
  trialFamilyView,
  trialMilestone,
  trialOutcomeLine,
  normaliseTrialClientKey,
  trialRoleAllows,
} from '../../../domains/recruitment/lifecycle/trial.mjs';
import { LIFECYCLE_ERROR_HTTP, httpStatusFor } from '../../../domains/recruitment/lifecycle/errors.mjs';
import { EVENT_REGISTRY } from '../../../domains/platform/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import { DATA_MIGRATIONS } from '../../../repositories/index.mjs';
import { STATUS_EVIDENCE_REQUIRED, roomCan } from '../../../domains/recruitment/rooms/shared.mjs';
import { EVIDENCE_KINDS } from '../../../domains/recruitment/lifecycle/evidence.mjs';
import { createEvidenceProvider } from '../../recruitmentReadsFixture.mjs'; // the contacts/offers queries over plain arrays
import { rulesSuite } from '../../rulesSuite.mjs';
const LATEST_SCHEMA = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
); // the latest table migration's number

const { ok, neg, section, done } = rulesSuite('recruitment/trials');

const S_NOTE = 'PRIVATE_TRIAL_NOTE_SENTINEL_5284';
const S_EMERG = 'PRIVATE_EMERGENCY_SENTINEL_7713';
const H = 3_600_000;
const has = (o, s) => JSON.stringify(o ?? null).includes(s);

// ============================================================ U — pure engine
section('U — timezones and instants: exact IANA, calendar-valid, one clock');
{
  ok(
    validateTimezone('Europe/London').ok &&
      validateTimezone('UTC').ok &&
      validateTimezone('Asia/Kolkata').ok &&
      validateTimezone('Europe/Kyiv').ok &&
      validateTimezone('America/St_Johns').ok,
    'U1 exact IANA identifiers are accepted — including current names an older ICU still reports under a legacy alias (D-P4B-1)',
  );
  neg(
    validateTimezone('asia/kolkata').ok === false &&
      validateTimezone('Asia/kolkata').ok === false &&
      validateTimezone('europe/kyiv').ok === false,
    'U1b the modern-name path folds no case either',
  );
  for (const bad of [
    'europe/london',
    'Europe/london',
    'Mars/Olympus',
    'GMT+1',
    'BST',
    'Z',
    '',
    ' UTC',
    'UTC ',
    null,
    undefined,
    42,
    {},
    [],
    'constructor',
    '__proto__',
    'hasOwnProperty',
  ]) {
    const v = validateTimezone(bad);
    neg(
      v.ok === false && v.error === 'TRIAL_TIMEZONE_INVALID',
      `U2 "${String(bad)}" is not a timezone (exact match, no case folding, no offsets)`,
    );
  }
  ok(
    parseInstant('2026-11-02T09:30:00Z').ok &&
      parseInstant('2026-11-02T09:30:00+01:00').ok &&
      parseInstant(1_800_000_000_000).ok,
    'U3 ISO with Z or an offset, or integer milliseconds, are instants',
  );
  for (const bad of [
    '2026-11-02T09:30:00',
    '2026-11-02',
    '2026-02-30T10:00:00Z',
    '2026-13-01T10:00:00Z',
    '2026-04-31T10:00:00Z',
    'tomorrow',
    '',
    null,
    1.5,
    '1800000000000',
    -1,
    NaN,
    Infinity,
    {},
    [],
    true,
    '1999-12-31T23:59:59Z',
    '2101-01-01T00:00:00Z',
    '2026-11-02T24:00:00Z',
    '2026-11-02T09:60:00Z',
  ]) {
    const v = parseInstant(bad);
    neg(
      v.ok === false,
      `U4 ${JSON.stringify(bad)} is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only`,
    );
  }
  // Leap day and DST: the organiser's local day is what the family sees.
  ok(parseInstant('2028-02-29T10:00:00Z').ok, 'U5 29 February 2028 is a real day');
  neg(parseInstant('2027-02-29T10:00:00Z').ok === false, 'U5b 29 February 2027 is not');
  const dst = parseInstant('2026-03-29T00:30:00Z').ms; // 00:30 UTC = 00:30 GMT, before the 01:00 UTC spring-forward
  ok(
    localDay(dst, 'Europe/London') === '2026-03-29' && localDay(dst + 2 * H, 'Europe/London') === '2026-03-29',
    'U6 the spring-forward instant keeps its London day on both sides of the gap',
  );
  ok(
    localDay(parseInstant('2026-11-02T23:30:00Z').ms, 'Asia/Kolkata') === '2026-11-03' &&
      localDay(parseInstant('2026-11-02T23:30:00Z').ms, 'America/Los_Angeles') === '2026-11-02',
    'U7 the same instant is a different calendar day in different zones — never a bare date',
  );
  ok(
    icsLocal(parseInstant('2026-07-01T09:00:00Z').ms, 'Europe/London') === '20260701T100000',
    'U8 ICS local form is wall-clock in the organiser zone (BST +1)',
  );
  ok(
    icsText('a;b,c\\d\nline') === 'a\\;b\\,c\\\\d\\nline',
    'U9 ICS text escaping covers ; , backslash and line breaks',
  );
}

section('U — schedules: bounds, overlap, stable ids, material change');
{
  const NOW = parseInstant('2026-10-01T12:00:00Z').ms;
  let seq = 0;
  const mint = () => `tses-${++seq}`;
  const venue = { name: 'Dome', town: 'Eastport' };
  const s = (h1, h2, extra = {}) => ({ startsAt: NOW + h1 * H, endsAt: NOW + h2 * H, venue, ...extra });
  const good = validateScheduleInput(
    { timezone: 'Europe/London', sessions: [s(2, 4), s(26, 28, { kind: 'match' })] },
    { now: NOW, mintId: mint },
  );
  ok(
    good.ok &&
      good.schedule.sessions.length === 2 &&
      good.schedule.sessions[0].id === 'tses-1' &&
      good.schedule.sessions[1].kind === 'match' &&
      good.schedule.sessions[0].kind === 'training',
    'U10 a valid schedule mints stable ids and defaults the kind to training',
  );
  neg(
    validateScheduleInput({ timezone: 'Europe/London', sessions: [] }, { now: NOW, mintId: mint }).error ===
      'TRIAL_SCHEDULE_INVALID',
    'U11 zero sessions is not a schedule',
  );
  neg(
    validateScheduleInput(
      { timezone: 'Europe/London', sessions: Array.from({ length: 21 }, (_, i) => s(2 + i * 24, 4 + i * 24)) },
      { now: NOW, mintId: mint },
    ).error === 'TRIAL_SCHEDULE_INVALID',
    'U12 twenty-one sessions is over the limit',
  );
  ok(
    validateScheduleInput(
      { timezone: 'Europe/London', sessions: Array.from({ length: 20 }, (_, i) => s(2 + i * 24, 4 + i * 24)) },
      { now: NOW, mintId: mint },
    ).ok,
    'U12b twenty is the limit, inclusive',
  );
  neg(
    validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 4), s(3, 5)] }, { now: NOW, mintId: mint })
      .error === 'TRIAL_SCHEDULE_INVALID',
    'U13 overlapping sessions are refused server-side',
  );
  ok(
    validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 4), s(4, 6)] }, { now: NOW, mintId: mint }).ok,
    'U13b back-to-back sessions (end == next start) do not overlap',
  );
  neg(
    validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 2.2)] }, { now: NOW, mintId: mint }).error ===
      'TRIAL_SCHEDULE_INVALID',
    'U14 a 12-minute session is under the 15-minute minimum',
  );
  neg(
    validateScheduleInput({ timezone: 'Europe/London', sessions: [s(2, 14.5)] }, { now: NOW, mintId: mint }).error ===
      'TRIAL_SCHEDULE_INVALID',
    'U14b a 12.5-hour session is over the 12-hour maximum',
  );
  neg(
    validateScheduleInput({ timezone: 'Europe/London', sessions: [s(-5, -3)] }, { now: NOW, mintId: mint }).error ===
      'TRIAL_SCHEDULE_INVALID',
    'U15 a session entirely in the past is refused',
  );
  ok(
    validateScheduleInput({ timezone: 'Europe/London', sessions: [s(-0.5, 0.5)] }, { now: NOW, mintId: mint }).ok,
    'U15b a session already under way (ends in the future) is allowed — it is happening',
  );
  neg(
    validateScheduleInput({ timezone: 'Europe/London', sessions: [s(4, 2)] }, { now: NOW, mintId: mint }).error ===
      'TRIAL_SCHEDULE_INVALID',
    'U16 end before start is refused',
  );
  neg(
    validateScheduleInput(
      { timezone: 'Europe/London', sessions: [s(2, 4, { kind: 'sparring' })] },
      { now: NOW, mintId: mint },
    ).error === 'TRIAL_SCHEDULE_INVALID',
    'U17 an unknown session kind is refused',
  );
  neg(
    validateScheduleInput(
      { timezone: 'Europe/London', sessions: [s(2, 4, { id: 'tses-999' })] },
      { now: NOW, mintId: mint, existingIds: ['tses-1'] },
    ).error === 'TRIAL_SESSION_NOT_FOUND',
    'U18 a revision naming a session id the trial never had is refused',
  );
  neg(
    validateScheduleInput(
      { timezone: 'Europe/London', sessions: [s(2, 4, { id: 'tses-1' }), s(26, 28, { id: 'tses-1' })] },
      { now: NOW, mintId: mint, existingIds: ['tses-1'] },
    ).error === 'TRIAL_SCHEDULE_INVALID',
    'U19 the same session id twice is refused',
  );
  neg(
    validateScheduleInput(
      { timezone: 'Europe/London', sessions: [s(2, 4, { id: 7 })] },
      { now: NOW, mintId: mint, existingIds: ['tses-1'] },
    ).ok === false,
    'U19b a numeric session id is not coerced into a string id',
  );
  neg(
    validateScheduleInput(
      { timezone: 'Europe/London', sessions: [{ ...s(2, 4), venue: 'Dome' }] },
      { now: NOW, mintId: mint },
    ).ok === false,
    'U20 a venue must be an object with a name, not a bare string',
  );
  neg(
    validateVenue({ name: 'x'.repeat(TRIAL_LIMITS.venueName + 1), town: 'T' }).ok === false &&
      validateVenue({ name: '', town: 'T' }).ok === false &&
      validateVenue(null).ok === false,
    'U20b venue name bounds and presence are enforced',
  );
  neg(
    validateScheduleInput({ timezone: 'Europe/London', sessions: 'lots' }, { now: NOW, mintId: mint }).error ===
      'TRIAL_SCHEDULE_INVALID' &&
      validateScheduleInput('x', { now: NOW, mintId: mint }).error === 'TRIAL_SCHEDULE_INVALID' &&
      validateScheduleInput({ timezone: 'Europe/London', sessions: [null] }, { now: NOW, mintId: mint }).error ===
        'TRIAL_SCHEDULE_INVALID',
    'U21 wrong input types are refused, never iterated as if they were lists',
  );
  neg(
    validateSessionInput({ ...s(2, 4), instructions: 'x'.repeat(TRIAL_LIMITS.instructions + 1) }, { now: NOW }).ok ===
      false && validateSessionInput({ ...s(2, 4), instructions: 12 }, { now: NOW }).ok === false,
    'U22 instructions are bounded text',
  );
  const prev = {
    timezone: 'Europe/London',
    sessions: [{ id: 'a', startsAt: 1, endsAt: 2, venue: { name: 'Dome', town: 'E' } }],
  };
  neg(
    materialChange(prev, { timezone: 'Europe/Paris', sessions: prev.sessions }) === true,
    'U23 a timezone change is material',
  );
  neg(
    materialChange(prev, { timezone: 'Europe/London', sessions: [{ ...prev.sessions[0], startsAt: 3, endsAt: 4 }] }) ===
      true,
    'U23b a time change is material',
  );
  neg(
    materialChange(prev, {
      timezone: 'Europe/London',
      sessions: [{ ...prev.sessions[0], venue: { name: 'Arena', town: 'E' } }],
    }) === true,
    'U23c a venue name change is material',
  );
  ok(
    materialChange(prev, {
      timezone: 'Europe/London',
      sessions: [
        {
          ...prev.sessions[0],
          instructions: 'Bring boots',
          venue: { name: 'Dome', town: 'E', address: '1 Road' },
          kind: 'match',
        },
      ],
    }) === false,
    'U23d instructions, the address line and the kind are not material — the confirmation stands',
  );
  ok(materialChange(null, prev) === true, 'U23e the first schedule is always material');
}

section('U — states, gates and views');
{
  ok(
    Object.isFrozen(TRIAL_WORKFLOW_STATES) &&
      TRIAL_WORKFLOW_STATES.join(',') === 'legacy_accepted,accepted,scheduled,completed,cancelled',
    'U30 five workflow states, frozen',
  );
  neg(
    TRIAL_WORKFLOW_STATES.every(
      (s) => !['awaiting_report', 'reported', 'trial_requested', 'trial_scheduled', 'trial_completed'].includes(s),
    ),
    'U31 no workflow state is a report status or a case status — three vocabularies, no shared word',
  );
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    neg(TRIAL_WORKFLOW_LABELS[key] === undefined, `U32 "${key}" is not a workflow label (null prototype)`);
  }
  const legacy = { id: 't', orgId: 'o', playerId: 'p', status: 'awaiting_report' };
  ok(
    isLegacyTrial(legacy) &&
      deriveWorkflowState(legacy) === 'legacy_accepted' &&
      deriveWorkflowState({ ...legacy, workflowState: 'legacy_accepted' }) === 'legacy_accepted',
    'U33 a pre-P4B row derives legacy_accepted from the absence of containers',
  );
  const acc = { ...legacy, workflowState: 'accepted', schedule: null, attendance: [], completion: null };
  ok(deriveWorkflowState(acc) === 'accepted', 'U34 accepted without a schedule');
  const proposed = {
    ...acc,
    schedule: { confirmedAt: null, sessions: [{ id: 's1', startsAt: 10, endsAt: 20 }], revision: 1, revisions: [] },
  };
  neg(
    deriveWorkflowState(proposed) === 'accepted',
    'U35 a PROPOSED schedule is not scheduled — the recipient has not confirmed',
  );
  const sched = { ...proposed, schedule: { ...proposed.schedule, confirmedAt: 5 }, workflowState: 'scheduled' };
  ok(deriveWorkflowState(sched) === 'scheduled', 'U36 a confirmed schedule with a session is scheduled');
  neg(
    deriveWorkflowState({ ...sched, schedule: { ...sched.schedule, sessions: [] } }) === 'accepted',
    'U36b a confirmed schedule with no sessions is not scheduled',
  );
  ok(
    deriveWorkflowState({ ...sched, completion: { state: 'cancelled', at: 1 } }) === 'cancelled' &&
      deriveWorkflowState({ ...sched, completion: { state: 'completed', at: 1 } }) === 'completed',
    'U37 completion.state wins over everything',
  );
  neg(
    canComplete(acc, { now: 100 }).reasons.join(',') ===
      'schedule_not_confirmed,no_attended_session,last_session_not_ended',
    'U38 completing an accepted trial names all three missing requirements',
  );
  neg(
    canComplete(sched, { now: 100 }).reasons.join(',') === 'no_attended_session',
    'U39 a scheduled trial after its last session but without attendance is not completable',
  );
  neg(
    canComplete({ ...sched, attendance: [{ sessionId: 's1', state: 'no_show' }] }, { now: 100 }).reasons.join(',') ===
      'no_attended_session',
    'U39b a no-show is attendance recorded, but not attendance taken',
  );
  neg(
    canComplete({ ...sched, attendance: [{ sessionId: 's1', state: 'attended' }] }, { now: 15 }).reasons.join(',') ===
      'last_session_not_ended',
    'U40 attended, but the last session is still running',
  );
  ok(
    canComplete({ ...sched, attendance: [{ sessionId: 's1', state: 'partial' }] }, { now: 20 }).ok === true,
    'U41 partial attendance and the last session ended (end == now) completes',
  );
  neg(
    canComplete(
      {
        ...sched,
        attendance: [
          { sessionId: 's1', state: 'no_show' },
          { sessionId: 's1', state: 'attended' },
        ],
      },
      { now: 20 },
    ).ok === true &&
      canComplete(
        {
          ...sched,
          attendance: [
            { sessionId: 's1', state: 'attended' },
            { sessionId: 's1', state: 'no_show' },
          ],
        },
        { now: 20 },
      ).ok === false,
    'U42 attendance is append-only and the LAST record is current',
  );
  neg(
    canComplete({ ...sched, completion: { state: 'completed' } }, { now: 20 }).error === 'TRIAL_INVALID_STATE' &&
      canComplete({ ...sched, completion: { state: 'cancelled' } }, { now: 20 }).reasons.includes('trial_cancelled'),
    'U43 a completed trial is not completed twice; a cancelled one is not completed at all',
  );
  const M = (t, actions) => actions.map((a) => (trialStateAllows(t, a) ? 1 : 0)).join('');
  const ACTS = ['schedule', 'reschedule', 'cancel', 'attendance', 'complete', 'link', 'confirm'];
  ok(
    M(acc, ACTS) === '1010000' && M(proposed, ACTS) === '1110001' && M(sched, ACTS) === '1111110',
    'U44 the state × action matrix: accepted/proposed/scheduled',
  );
  neg(
    M({ ...sched, completion: { state: 'completed' } }, ACTS) === '0000010' &&
      M({ ...sched, completion: { state: 'cancelled' } }, ACTS) === '0000000',
    'U45 completed allows only evidence linking; cancelled allows nothing',
  );
  neg(
    trialStateAllows(sched, 'assess') === false && trialStateAllows(sched, 'constructor') === false,
    'U46 an unknown action is never allowed',
  );
  ok(blockedAllows('cancel') && blockedAllows('report'), 'U47 a blocked club may cancel and file the mandatory report');
  neg(
    ['schedule', 'reschedule', 'attendance', 'complete', 'link', 'invite', 'assess'].every(
      (a) => blockedAllows(a) === false,
    ),
    'U47b and may do nothing else',
  );
  ok(
    trialRoleAllows('recruitment_admin', 'trial_write') &&
      trialRoleAllows('room_lead', 'trial_write') &&
      trialRoleAllows('contributor', 'trial_assess') &&
      trialRoleAllows('viewer', 'trial_view'),
    'U48 write is lead+, assess is member+, view is everyone in the room',
  );
  neg(
    !trialRoleAllows('contributor', 'trial_write') &&
      !trialRoleAllows('viewer', 'trial_assess') &&
      !trialRoleAllows(null, 'trial_view') &&
      !trialRoleAllows('admin', 'trial_view'),
    'U48b a contributor cannot write, a viewer cannot assess, no role is no access',
  );
  ok(
    roomCan('contributor', 'trial_assess') &&
      !roomCan('contributor', 'trial_write') &&
      roomCan('room_lead', 'trial_write'),
    'U49 roomCan carries the same three actions (one permission table)',
  );
  const corrupt = [
    [{ ...sched, orgId: 'other' }, 'org_mismatch'],
    [{ ...sched, workflowState: 'accepted' }, 'state_mismatch'],
    [{ ...sched, workflowState: 'flying' }, 'state_unknown'],
    [{ ...sched, attendance: 'yes' }, 'attendance_not_list'],
    [{ ...sched, schedule: { ...sched.schedule, sessions: [{ id: 's1', startsAt: 20, endsAt: 10 }] } }, 'session_time'],
    [{ ...sched, attendance: [{ sessionId: 'ghost', state: 'attended' }] }, 'attendance_orphan'],
    [{ ...sched, completion: { state: 'done' } }, 'completion_state'],
    [{ ...sched, schedule: { ...sched.schedule, timezone: 'Mars/Olympus' } }, 'timezone'],
    [{ ...sched, caseId: 'k2' }, 'case_mismatch'],
  ];
  for (const [row, what] of corrupt)
    neg(
      trialIntegrity(row, { orgId: 'o', caseId: 'k1' }).length > 0,
      `U50 a corrupt row (${what}) fails integrity instead of being served`,
    );
  ok(
    trialIntegrity(
      { ...sched, caseId: 'k1', schedule: { ...sched.schedule, timezone: 'Europe/London' } },
      { orgId: 'o', caseId: 'k1' },
    ).length === 0,
    'U50b a sound row passes',
  );
  const full = {
    ...sched,
    caseId: 'k1',
    playerName: 'P',
    orgName: 'O',
    acceptedAt: 1,
    proposedDate: '2026-10-01',
    venue: 'Dome',
    schedule: {
      ...sched.schedule,
      timezone: 'Europe/London',
      sessions: [
        {
          id: 's1',
          startsAt: 10,
          endsAt: 20,
          kind: 'training',
          venue: { name: 'Dome', town: 'E', address: 'Gate B' },
          instructions: 'Ask for Priya',
          evidence: [{ id: 'e1', kind: 'box_cam_session', sessionId: 'bx1', linkedAt: 1 }],
        },
      ],
    },
    attendance: [
      {
        sessionId: 's1',
        state: 'attended',
        source: 'manual',
        recordedAt: 12,
        recordedBy: { kind: 'org', userId: 'u1', name: 'Maria' },
        note: S_NOTE,
      },
    ],
    history: [
      {
        id: 'aud-1',
        at: 1,
        action: 'trial_accepted',
        by: { kind: 'player', id: 'p', name: 'Kola' },
        detail: { day: '2026-10-01' },
      },
    ],
    recipient: { type: 'player', playerId: 'p', guardianId: null, minor: false },
    keys: { accept: { key: 'secret-key', fp: 'x' } },
    day: { emergency: { name: S_EMERG, phone: '0777' }, staff: [] },
    rev: 3,
  };
  const cv = trialClubView(full);
  const fv = trialFamilyView(full);
  const mv = trialMilestone(full);
  const ov = trialOutcomeLine(full);
  ok(
    cv.workflowState === 'scheduled' &&
      cv.rev === 3 &&
      cv.caseId === 'k1' &&
      cv.schedule.sessions[0].instructions === 'Ask for Priya' &&
      cv.attendanceHistory[0].note === S_NOTE,
    "U51 the club view carries the operational record, including the club's own note",
  );
  neg(
    !has(cv, S_EMERG) && !has(cv, 'secret-key') && !has(cv, '0777'),
    "U52 the club view never carries the family's emergency contact or an idempotency key",
  );
  neg(
    !has(fv, 'k1') &&
      !has(fv, S_NOTE) &&
      !has(fv, 'bx1') &&
      !has(fv, 'aud-1') &&
      fv.caseId === undefined &&
      fv.history === undefined &&
      fv.attendanceHistory === undefined,
    'U53 the family view has no case id, no club note, no evidence link and no history internals',
  );
  ok(
    fv.schedule.sessions[0].venue.address === 'Gate B' &&
      fv.schedule.sessions[0].instructions === 'Ask for Priya' &&
      fv.awaitingYourConfirmation === false,
    'U53b the family view shares the address and instructions (accepted trial)',
  );
  neg(
    !has(mv, 'Ask for Priya') &&
      !has(mv, 'Gate B') &&
      !has(mv, S_NOTE) &&
      mv.sessions[0].attendance === 'attended' &&
      mv.sessions[0].evidenceCount === 1,
    'U54 the milestone is ids, states, times and counts — never text',
  );
  neg(
    Object.keys(ov).sort().join(',') === 'guardianManaged,id,orgName,workflowLabel,workflowState',
    "U55 the minor's outcome line is exactly five fields",
  );
  ok(
    normaliseTrialClientKey(undefined).ok &&
      normaliseTrialClientKey(undefined).key === null &&
      normaliseTrialClientKey('k-1').key === 'k-1',
    'U56 a client key is optional',
  );
  neg(
    normaliseTrialClientKey('x'.repeat(TRIAL_LIMITS.clientKey + 1)).error === 'TRIAL_CLIENT_KEY_INVALID' &&
      normaliseTrialClientKey(12).error === 'TRIAL_CLIENT_KEY_INVALID' &&
      normaliseTrialClientKey({}).error === 'TRIAL_CLIENT_KEY_INVALID' &&
      normaliseTrialClientKey([]).error === 'TRIAL_CLIENT_KEY_INVALID',
    'U56b too long, numeric, object or list keys are refused (an empty string is simply no key)',
  );
}

// ================================================================ P — policy
section('P — error bands, rate policies, events, migration, evidence, permissions');
{
  const TRIAL_CODES = Object.keys(LIFECYCLE_ERROR_HTTP).filter((c) => c.startsWith('TRIAL_'));
  ok(TRIAL_CODES.length >= 24, `P1 ${TRIAL_CODES.length} TRIAL_* codes carry an HTTP band`);
  ok(
    httpStatusFor('TRIAL_REV_REQUIRED') === 400 &&
      httpStatusFor('TRIAL_NOT_PERMITTED') === 403 &&
      httpStatusFor('TRIAL_NOT_FOUND') === 404 &&
      httpStatusFor('TRIAL_VERSION_CONFLICT') === 409 &&
      httpStatusFor('TRIAL_GUARDIAN_REQUIRED') === 422 &&
      httpStatusFor('TRIAL_INVITE_COOLDOWN') === 429 &&
      httpStatusFor('TRIAL_TRANSPORT_REFUSED') === 500,
    'P2 the bands: 400 input, 403 permission, 404 absence, 409 state, 422 recipient, 429 cooldown, 500 transport',
  );
  neg(
    TRIAL_CODES.every((c) => [400, 403, 404, 409, 422, 429, 500].includes(LIFECYCLE_ERROR_HTTP[c])),
    'P2b no TRIAL code lands outside the declared bands',
  );
  for (const a of ['trial_invite', 'trial_schedule', 'trial_response', 'trial_evidence_link', 'trial_attendance'])
    ok(
      RATE_LIMIT_POLICY[a]?.max > 0 && RATE_LIMIT_POLICY[a].windowMs > 0,
      `P3 rate policy ${a} (${RATE_LIMIT_POLICY[a]?.max}/window, ${RATE_LIMIT_POLICY[a]?.scope})`,
    );
  ok(
    RATE_LIMIT_POLICY.trial_response.scope === 'actor' && RATE_LIMIT_POLICY.trial_invite.scope === 'org',
    'P3b responses are limited per actor; invitations per organisation',
  );
  const EVENTS = [
    'trial_invited',
    'trial_accepted',
    'trial_declined',
    'trial_scheduled',
    'trial_rescheduled',
    'trial_cancelled',
    'trial_attendance_recorded',
    'trial_completed',
    'trial_evidence_linked',
  ];
  for (const e of EVENTS) {
    const r = EVENT_REGISTRY[e];
    ok(
      !!r &&
        r.audience === 'org_private' &&
        r.privacyClass === 'org_internal' &&
        r.replayPolicy === 'never' &&
        r.analyticsEligible === false,
      `P4 event ${e} is registered org_private / org_internal, never replayed, never analytics`,
    );
    neg(
      !!r &&
        Array.isArray(r.payload) &&
        r.payload.every((k) => /Id$/.test(k)) &&
        !r.payload.some((k) => /name|note|message|reason|address|instruction/i.test(k)),
      `P4b ${e} payload is ids only`,
    );
  }
  neg(
    EVENT_REGISTRY.trial_assessment_recorded === undefined && EVENT_REGISTRY.trial_observed === undefined,
    'P5 no event announces an assessment or an observation — judgement never broadcasts',
  );
  // That a trial row reads back with neutral containers, nothing renamed or invented, is proved on typed rows in
  // trialsPersistence section 1.
  ok(
    DATA_MIGRATIONS.length === LATEST_SCHEMA && DATA_MIGRATIONS.some((m) => m.id === '0015_recruitment'),
    'P6 the current schema; the trials are typed rows of table migration 0015',
  );
  ok(
    STATUS_EVIDENCE_REQUIRED.trial_requested?.kind === 'trial_invited' &&
      STATUS_EVIDENCE_REQUIRED.trial_scheduled?.kind === 'trial_confirmed' &&
      STATUS_EVIDENCE_REQUIRED.trial_completed?.kind === 'trial_completed',
    'P9 the three trial stages are evidence-gated: invited, confirmed, completed',
  );
  ok(
    EVIDENCE_KINDS.includes('trial_invited') &&
      EVIDENCE_KINDS.includes('trial_confirmed') &&
      EVIDENCE_KINDS.includes('trial_completed'),
    'P9b the evidence provider knows all three kinds',
  );
  const kase = { id: 'k1', orgId: 'o', playerId: 'p' };
  const chk = (db, kind) => createEvidenceProvider(db).check(kind, { kase });
  neg(
    chk({ requests: [], trials: [] }, 'trial_invited').satisfied === false &&
      chk({ requests: [], trials: [] }, 'trial_confirmed').satisfied === false &&
      chk({ requests: [], trials: [] }, 'trial_completed').satisfied === false,
    'P10 with nothing recorded, no trial stage has evidence',
  );
  neg(
    chk({}, 'trial_invited').satisfied === false &&
      chk({}, 'trial_invited').reason === 'requests_store_unavailable' &&
      chk({}, 'trial_confirmed').reason === 'trials_store_unavailable',
    'P10b a missing store is NOT evidence — the provider fails closed and names the store',
  );
  const dbEv = {
    requests: [{ id: 'r1', type: 'trial', caseId: 'k1', orgId: 'o', playerId: 'p', status: 'pending' }],
    trials: [],
  };
  ok(chk(dbEv, 'trial_invited').satisfied === true, 'P11 a pending invitation is evidence for trial_requested');
  dbEv.requests[0].status = 'declined';
  neg(chk(dbEv, 'trial_invited').satisfied === false, 'P11b a declined invitation is not');
  dbEv.requests[0].status = 'accepted';
  const t = {
    id: 't',
    orgId: 'o',
    playerId: 'p',
    caseId: 'k1',
    status: 'awaiting_report',
    workflowState: 'accepted',
    schedule: {
      timezone: 'UTC',
      revision: 1,
      confirmedAt: null,
      sessions: [{ id: 's', startsAt: 10, endsAt: 20, kind: 'training' }],
      revisions: [],
    },
    attendance: [],
    completion: null,
    rev: 1,
  };
  dbEv.trials.push(t);
  neg(
    chk(dbEv, 'trial_confirmed').satisfied === false,
    'P12 a proposed, unconfirmed schedule is not evidence for trial_scheduled',
  );
  t.schedule.confirmedAt = 5;
  t.workflowState = 'scheduled';
  ok(chk(dbEv, 'trial_confirmed').satisfied === true, 'P12b a confirmed schedule is');
  neg(chk(dbEv, 'trial_completed').satisfied === false, 'P13 scheduled is not completed');
  t.completion = { state: 'cancelled', at: 30 };
  t.workflowState = 'cancelled';
  neg(chk(dbEv, 'trial_completed').satisfied === false, 'P13b cancelled is not completed either');
  t.completion = { state: 'completed', at: 30 };
  t.workflowState = 'completed';
  ok(chk(dbEv, 'trial_completed').satisfied === true, 'P13c an explicit completion is');
  t.subjectRemovedAt = 40;
  ok(chk(dbEv, 'trial_completed').satisfied === true, 'P13d a tombstoned completed trial is still what happened');
}

done();
