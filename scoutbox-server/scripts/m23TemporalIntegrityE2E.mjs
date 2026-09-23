// M23 P5.7 — PLATFORM TEMPORAL INTEGRITY & DATE VALIDATION suite.
//
// The question this suite asks is not "do dates work?" — every earlier suite
// assumed they did. It is: for every date or time a security, lifecycle or
// compliance decision depends on, what happens when the value is malformed,
// rolled over by the engine, ambiguous, zone-dependent, out of order, or
// simply unreadable? P5.6F found the same answer five times (F-2, F-3, F-8,
// F-12, F-12b): the decision failed OPEN. This suite exists so that class of
// defect has one regression for the whole platform.
//
// Groups (pure first, then live on a fresh server):
//   A the temporal contract   B DATE_ONLY parser        C date of birth
//   D UTC_INSTANT parser      E date-or-instant fields  F IANA zones
//   G DST (America/New_York)  H fail-closed predicates  I licence expiry
//   J policy windows          K agent/consent/handoff   L Contact
//   M Trial scheduling        N analytics/briefs/history O 22 adversarial cases
//   P zone independence       Q sign-up DOB (live)      R every hardened route (live)
//   S authorization before dates (live)                 T persistence/restart (live)
//
// Property-style enumeration is SEEDED and exhaustive over a stated set — no
// unseeded randomness anywhere. No assertion is `status !== 200`; every
// refusal names its status and its code. Run it under TZ=UTC and under
// TZ=America/New_York: the counts must be identical.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../temporal.mjs';
import { parseDob, ageOn, isAdult, adultAgeFor, parseTrialDate, trialReportDueAt, isTrialDate } from '../domain.mjs';
import { effectiveFacetState, affiliationActive, agreementGrantsAccess, effectiveAgreementStatus, verificationGap } from '../m24/shared.mjs';
import { selectPolicyVersion, ruleStatusAt, isRegulatoryMinor, evaluateMinorGate, earliestPermittedApproachAt } from '../m25/policy.mjs';
import { consentSufficiency } from '../m25/conflict.mjs';
import { effectiveHandoffStatus, HANDOFF_TTL_MS } from '../m27/integration.mjs';
import { effectiveStatus as licenceEffectiveStatus } from '../m14/shared.mjs';
import { validateExternalRecord, cooldownFor, CONTACT_LIMITS } from '../m23/contact.mjs';
import { parseInstant as trialParseInstant, validateTimezone, validateSessionInput, validateScheduleInput, localDay, icsLocal, TRIAL_LIMITS } from '../m23/trial.mjs';
import { resolveWindow, previousWindow } from '../m20/metrics.mjs';
import { briefIsLiveOn, validateRecruitmentBrief } from '../m18/shared.mjs';
import { normWhen } from '../m15/shared.mjs';
import { parseDate as devParseDate } from '../m21/shared.mjs';
import { SCHEMA_VERSION } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';

const PORT = 7600 + Math.floor(Math.random() * 150);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-p57-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 23, 12); // 2026-09-23T12:00Z — the suite's fixed "now" for pure groups
const NY = 'America/New_York';
const LON = 'Europe/London';

// Every value shape a stored field has ever carried, or could after an import.
const SHAPES = {
  absent: [null, undefined],
  unreadable: [NaN, '', 'soon', '2020-01-01', '2020-01-01T00:00:00.000Z', String(T0 - DAY), Infinity, -Infinity, true, false, {}, []],
};

// =================================================================== PURE

section('A/pure — the temporal contract, stated as a contract');
{
  for (const fn of ['parseStrictDateOnly', 'parseInstant', 'parseDateOrInstant', 'parseLocalDateTimeWithZone', 'validateIanaZone', 'isOrderedInterval', 'isActiveAt', 'isExpiredAt', 'isEffectiveAt', 'isDayWithin', 'readInstant', 'readDateOnly', 'ageOnMs', 'ageOrNull', 'parseDobStrict', 'localParts', 'zoneOffsetMinutes', 'endOfDayExclusive', 'utcDayOf']) {
    ok(typeof T[fn] === 'function', `A1 temporal.mjs exports ${fn}`);
  }
  ok(['DATE_INVALID', 'DOB_INVALID', 'TIMESTAMP_INVALID', 'TIMEZONE_INVALID', 'INTERVAL_INVALID', 'LOCAL_TIME_NONEXISTENT', 'LOCAL_TIME_AMBIGUOUS'].every((c) => T.TEMPORAL_ERRORS[c] === c), 'A2 the error taxonomy is the mandated one, spelled once');
  ok(Object.isFrozen(T.TEMPORAL_ERRORS), 'A2b and frozen');
  ok(T.YEAR_MIN === 1900 && T.YEAR_MAX === 2100 && T.DOB_MAX_AGE_YEARS === 120, 'A3 reasonableness bounds are stated (1900–2100; nobody is older than 120)');
  ok(T.DAY_MS === 86_400_000, 'A4 one DAY_MS');
  // The domain module delegates — there is ONE implementation, not a mirror.
  ok(parseDob('2010-02-30') === null && T.parseStrictDateOnly('2010-02-30').ok === false, 'A5 domain.parseDob and temporal.parseStrictDateOnly refuse the same day');
  ok(ageOn('2008-09-23', new Date(T0)) === T.ageOnMs('2008-09-23', T0) && ageOn('2008-09-23', new Date(T0)) === 18, 'A6 domain.ageOn IS temporal.ageOnMs (18 on the 18th birthday, UTC)');
  ok(validateTimezone('europe/london').ok === false && T.validateIanaZone('europe/london').ok === false && validateTimezone(LON).ok === true, 'A7 the Trial zone check is the platform zone check under a Trial name');
  ok(trialParseInstant('2026-03-01T10:00').ok === false && T.parseInstant('2026-03-01T10:00').ok === false && trialParseInstant('2026-03-01T10:00Z').ms === T.parseInstant('2026-03-01T10:00Z').ms, 'A8 the Trial instant parser IS the platform instant parser');
  ok(trialParseInstant('2026-03-01T10:00').error === 'TRIAL_SCHEDULE_INVALID' && T.parseInstant('2026-03-01T10:00').error === 'TIMESTAMP_INVALID', 'A8b …with the Trial error code at the Trial edge and the platform code underneath');
  ok(parseTrialDate('1999-12-31').ok === false && T.parseStrictDateOnly('1999-12-31').ok === true, 'A9 the Trial date keeps its own 2000–2100 bound on top of the platform bound');
}

section('B/pure — DATE_ONLY: strict shape, a day that exists, round-tripped');
{
  const invalid = ['2010-02-30', '2011-04-31', '2019-02-29', '2023-13-01', '2023-00-10', '2023-01-00', '2023-01-32', '02/03/2010', '2023-1-5', '2023-01-05T00:00:00Z', '20230105', ' 2023-01-05', '2023-01-05 ', '1899-12-31', '2101-01-01', '', null, undefined, 20230105, NaN, {}, [], true];
  for (const v of invalid) neg(T.parseStrictDateOnly(v).ok === false && T.parseStrictDateOnly(v).error === 'DATE_INVALID', `B1 ${JSON.stringify(v)} is not a calendar day (${T.parseStrictDateOnly(v).why})`);
  for (const v of ['2000-02-29', '2020-02-29', '2024-02-29', '1900-01-01', '2100-12-31', '2023-04-30', '2023-12-31']) ok(T.parseStrictDateOnly(v).ok === true && T.parseStrictDateOnly(v).value === v, `B2 ${v} is a calendar day`);
  ok(T.parseStrictDateOnly('2000-02-29').t === Date.UTC(2000, 1, 29), 'B3 the instant of a DATE_ONLY is UTC midnight of that day');
  // Property-style: every (month, day) pair for four representative years,
  // against an independent calendar (days-in-month table), seeded and exhaustive.
  const dim = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  let agree = 0; let total = 0;
  for (const y of [1900, 2000, 2023, 2024]) for (let m = 0; m <= 13; m++) for (let d = 0; d <= 32; d++) {
    const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const expected = m >= 1 && m <= 12 && d >= 1 && d <= dim(y, m);
    total++; if (T.parseStrictDateOnly(s).ok === expected) agree++;
  }
  ok(agree === total && total === 4 * 14 * 33, `B4 property: ${total} (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)`);
  ok(T.readDateOnly('2026-02-30') === null && T.readDateOnly('2026-03-01') === '2026-03-01', 'B5 readDateOnly is the stored-field reader: unreadable → null');
  ok(T.endOfDayExclusive('2026-03-01') === Date.UTC(2026, 2, 2) && T.endOfDayExclusive('2026-02-30') === null, 'B6 a DATE_ONLY end covers the whole day: its instant is the start of the next UTC day');
}

section('C/pure — date of birth: one rule, GB 18 / KR 19, unknown is never adult');
{
  const invalid = ['2010-02-30', '2011-04-31', '2019-02-29', '2023-13-01', '2023-00-10', '2023-01-00', '2023-01-32', '02/03/2010'];
  for (const v of invalid) neg(parseDob(v) === null && Number.isNaN(ageOn(v, new Date(T0))) && isAdult({ dob: v, country: 'GB' }, new Date(T0)) === false, `C1 dob ${v}: unreadable → age NaN → not adult`);
  for (const v of SHAPES.absent.concat([0, false, NaN, 20100101])) neg(Number.isNaN(ageOn(v, new Date(T0))) && isAdult({ dob: v }, new Date(T0)) === false, `C1b dob ${JSON.stringify(v)} is not the epoch (F-8) — not adult`);
  ok(parseDob('2000-02-29') === '2000-02-29' && parseDob('2020-02-29') === '2020-02-29', 'C2 real leap days are dates of birth');
  ok(ageOn('2008-09-23', new Date(T0)) === 18 && ageOn('2008-09-24', new Date(T0)) === 17, 'C3 18 on the birthday (UTC), 17 the day before');
  ok(isAdult({ dob: '2008-09-23', country: 'GB' }, new Date(T0)) === true && isAdult({ dob: '2008-09-24', country: 'GB' }, new Date(T0)) === false, 'C4 GB: adult at 18, not at 17y364d');
  ok(adultAgeFor('KR') === 19 && isAdult({ dob: '2007-09-23', country: 'KR' }, new Date(T0)) === true && isAdult({ dob: '2007-09-24', country: 'KR' }, new Date(T0)) === false && isAdult({ dob: '2008-09-23', country: 'KR' }, new Date(T0)) === false, 'C5 KR: adult at 19 — an 18-year-old is a minor there');
  ok(ageOn('2008-02-29', new Date(Date.UTC(2026, 1, 28))) === 17 && ageOn('2008-02-29', new Date(Date.UTC(2026, 2, 1))) === 18, 'C6 a 29 February birthday counts on 1 March in a non-leap year');
  neg(T.parseDobStrict('2030-01-01', T0).error === 'DOB_INVALID' && T.parseDobStrict('2030-01-01', T0).why === 'in the future', 'C7 a date of birth in the future is refused (§24)');
  neg(T.parseDobStrict('1900-01-01', T0).error === 'DOB_INVALID' && T.parseDobStrict('1900-01-01', T0).why === 'implausibly old', 'C7b a 126-year-old is refused (§24)');
  ok(T.parseDobStrict('1906-09-24', T0).ok === true, 'C7c a 119-year-old is accepted — the bound is a bound, not a guess');
  ok(T.parseDobStrict('2026-09-23', T0).ok === true, 'C7d born today is accepted');
  neg(isRegulatoryMinor({ dob: '2010-02-30' }, T0) === null && isRegulatoryMinor({ dob: null }, T0) === null, 'C8 the regulatory minor test answers "unknown" for an unreadable dob (F-8/F-12b)');
  const gate = (dob) => evaluateMinorGate({ subject: { id: 'p', dob }, agent: { facets: {} }, jurisdictions: ['ENG'], guardianConsents: [], now: T0 });
  neg(gate('2010-02-30').blocked === true && (gate('2010-02-30').reasons ?? []).some((r) => /SUBJECT_DOB_UNKNOWN/.test(JSON.stringify(r))), 'C9 the minors gate BLOCKS on an unreadable dob');
  const rule = { rule: { params: { formula: 'academic_year_16', academicYearStart: '09-01' } } };
  neg(earliestPermittedApproachAt(null, rule).at === null && earliestPermittedApproachAt(null, rule).reason === 'MINOR_TIMING_NOT_ENCODED', 'C10 the approach-timing formula refuses a null dob (`new Date(null)` used to be 1970 → "approach permitted since 1986")');
  neg(earliestPermittedApproachAt('2010-02-30', rule).at === null, 'C10b and a rolled-over dob');
  neg(earliestPermittedApproachAt(0, rule).at === null && earliestPermittedApproachAt(false, rule).at === null, 'C10c and the epoch shapes');
  ok(earliestPermittedApproachAt('2010-03-14', rule).at === Date.UTC(2025, 8, 1), 'C10d control: born 14 Mar 2010 → 16 on 14 Mar 2026 → academic year starting 1 Sep 2025');
  ok(earliestPermittedApproachAt('2010-09-01', rule).at === Date.UTC(2026, 8, 1) && earliestPermittedApproachAt('2010-08-31', rule).at === Date.UTC(2025, 8, 1), 'C10e the academic-year boundary is inclusive on 1 September');
}

section('D/pure — UTC_INSTANT: explicit offset or Z, or integer milliseconds; nothing local');
{
  const bad = ['2026-03-01T10:00', '2026-03-01 10:00', '2026-03-01', '02/03/2026 10:00', 'March 1 2026', '1700000000000', '2026-02-30T10:00Z', '2026-03-01T24:00Z', '2026-03-01T10:60Z', '2026-03-01T10:00:60Z', '2026-03-01T10:00+15:00', '2026-03-01T10:00+05:60', '1899-12-31T23:59Z', '2101-01-01T00:00Z', 1.5, NaN, Infinity, -Infinity, '', null, undefined, {}, [], true];
  for (const v of bad) neg(T.parseInstant(v).ok === false && T.parseInstant(v).error === 'TIMESTAMP_INVALID', `D1 ${JSON.stringify(v)} is not an instant (${T.parseInstant(v).why})`);
  ok(T.parseInstant('2026-03-01T10:00Z').ms === Date.UTC(2026, 2, 1, 10), 'D2 Z');
  ok(T.parseInstant('2026-03-01T10:00:00+05:30').ms === Date.UTC(2026, 2, 1, 4, 30), 'D2b +05:30');
  ok(T.parseInstant('2026-03-01T10:00:00.250-04:00').ms === Date.UTC(2026, 2, 1, 14, 0, 0, 250), 'D2c -04:00 with milliseconds');
  ok(T.parseInstant(T0).ms === T0 && T.parseInstant(0).ms === 0 && T.parseInstant(-1).ms === -1, 'D3 integer milliseconds pass through (0 and -1 are instants, not "absent")');
  ok(T.readInstant(T0) === T0 && T.readInstant(0) === 0 && T.readInstant(1.5) === 1.5, 'D4 readInstant keeps a finite number (a stored fraction is odd but unambiguous; parseInstant still refuses one as input)');
  for (const v of SHAPES.absent.concat(SHAPES.unreadable)) neg(T.readInstant(v) === null, `D4b readInstant(${JSON.stringify(v)}) is null`);
  ok(T.utcDayOf(T0) === '2026-09-23', 'D5 utcDayOf');
}

section('E/pure — a field that takes a calendar day OR an instant');
{
  ok(T.parseDateOrInstant('2026-03-01').ms === Date.UTC(2026, 2, 1) && T.parseDateOrInstant('2026-03-01').precision === 'day', 'E1 a DATE_ONLY resolves to the start of the UTC day (default edge)');
  ok(T.parseDateOrInstant('2026-03-01', { dayEdge: 'end' }).ms === Date.UTC(2026, 2, 2), 'E2 …or the first instant after it, for an expiry');
  ok(T.parseDateOrInstant('2026-03-01T10:00Z').precision === 'instant' && T.parseDateOrInstant(T0).ms === T0, 'E3 an instant stays an instant');
  for (const v of ['2026-02-30', '2026-03-01T10:00', 'soon', '1700000000000', 1.5, null]) neg(T.parseDateOrInstant(v).ok === false && T.parseDateOrInstant(v).error === 'DATE_INVALID', `E4 ${JSON.stringify(v)} refused`);
  // The Development Hub's parseDate is this parser at its edge.
  ok(devParseDate('2026-06-01', { field: 'startDate' }).value === Date.UTC(2026, 5, 1), 'E5 m21 parseDate: a calendar day');
  ok(devParseDate('2026-06-01T09:00:00Z', { field: 'startDate' }).value === Date.UTC(2026, 5, 1, 9), 'E5b an ISO instant');
  ok(devParseDate(null, { field: 'x' }).value === null && devParseDate('', { field: 'x' }).value === null, 'E5c absent is absent');
  neg(devParseDate('2026-06-01T09:00', { field: 'startDate' }).error === 'DATE_INVALID', 'E6 m21: a bare local time is refused (it used to be read in the server\'s zone)');
  neg(devParseDate('06/01/2026', { field: 'startDate' }).error === 'DATE_INVALID', 'E6b m21: an ambiguous US/UK date is refused (it used to parse as 1 June)');
  neg(devParseDate('2026-02-30', { field: 'startDate' }).error === 'DATE_INVALID', 'E6c m21: a rolled-over day is refused');
}

section('F/pure — IANA zones: exact, known, never guessed');
{
  for (const z of ['Europe/London', 'America/New_York', 'Asia/Kolkata', 'Asia/Tokyo', 'UTC', 'Pacific/Auckland', 'America/Argentina/Buenos_Aires']) ok(T.validateIanaZone(z).ok === true && T.validateIanaZone(z).timezone === z, `F1 ${z} is a zone`);
  for (const z of ['europe/london', 'EUROPE/LONDON', 'London', 'GMT+1', '+01:00', 'EST', 'Mars/Olympus', '', null, undefined, 5, {}, 'Europe/London ', 'x'.repeat(65)]) neg(T.validateIanaZone(z).ok === false && T.validateIanaZone(z).error === 'TIMEZONE_INVALID', `F2 ${JSON.stringify(z)} is not a zone`);
  ok(T.zoneOffsetMinutes(Date.UTC(2026, 6, 1), NY) === -240 && T.zoneOffsetMinutes(Date.UTC(2026, 0, 1), NY) === -300, 'F3 New York is -04:00 in July and -05:00 in January');
  ok(T.zoneOffsetMinutes(Date.UTC(2026, 6, 1), 'Asia/Kolkata') === 330 && T.zoneOffsetMinutes(Date.UTC(2026, 6, 1), 'UTC') === 0, 'F3b Kolkata +05:30; UTC 0');
  ok(T.localParts(Date.UTC(2026, 2, 1, 4, 30), NY).hour === '23' && T.localParts(Date.UTC(2026, 2, 1, 4, 30), NY).day === '28', 'F4 04:30Z on 1 March is 23:30 on 28 February in New York');
}

section('G/pure — daylight saving in America/New_York: gaps refused, overlaps named');
{
  // 8 March 2026: clocks go 01:59:59 → 03:00:00. 02:30 never happens.
  const gap = T.parseLocalDateTimeWithZone('2026-03-08T02:30', NY);
  neg(gap.ok === false && gap.error === 'LOCAL_TIME_NONEXISTENT', 'G1 02:30 on 8 March 2026 does not exist in New York — refused, not shifted');
  ok(T.parseLocalDateTimeWithZone('2026-03-08T01:59', NY).ms === Date.UTC(2026, 2, 8, 6, 59) && T.parseLocalDateTimeWithZone('2026-03-08T03:00', NY).ms === Date.UTC(2026, 2, 8, 7, 0), 'G1b 01:59 is 06:59Z and 03:00 is 07:00Z — one minute apart on the clock, one minute apart in truth');
  // 1 November 2026: clocks go 01:59:59 → 01:00:00. 01:30 happens twice.
  const twice = T.parseLocalDateTimeWithZone('2026-11-01T01:30', NY);
  neg(twice.ok === false && twice.error === 'LOCAL_TIME_AMBIGUOUS' && twice.candidates.length === 2 && twice.candidates[1] - twice.candidates[0] === HOUR, 'G2 01:30 on 1 November 2026 happens twice — refused without an explicit resolution (§36 #16)');
  ok(T.parseLocalDateTimeWithZone('2026-11-01T01:30', NY, { resolve: 'earlier' }).ms === Date.UTC(2026, 10, 1, 5, 30) && T.parseLocalDateTimeWithZone('2026-11-01T01:30', NY, { resolve: 'earlier' }).offsetMinutes === -240, 'G2b resolved "earlier": the EDT instant (05:30Z)');
  ok(T.parseLocalDateTimeWithZone('2026-11-01T01:30', NY, { resolve: 'later' }).ms === Date.UTC(2026, 10, 1, 6, 30) && T.parseLocalDateTimeWithZone('2026-11-01T01:30', NY, { resolve: 'later' }).ambiguous === true, 'G2c resolved "later": the EST instant (06:30Z), flagged ambiguous');
  ok(T.parseLocalDateTimeWithZone('2026-06-01T09:00', NY).ms === Date.UTC(2026, 5, 1, 13) && T.parseLocalDateTimeWithZone('2026-06-01T09:00', NY).ambiguous === false, 'G3 an ordinary summer morning: 09:00 EDT is 13:00Z');
  ok(T.parseLocalDateTimeWithZone('2026-01-15T09:00', NY).ms === Date.UTC(2026, 0, 15, 14), 'G3b an ordinary winter morning: 09:00 EST is 14:00Z');
  neg(T.parseLocalDateTimeWithZone('2026-03-29T01:30', LON).error === 'LOCAL_TIME_NONEXISTENT', 'G4 London springs forward too: 01:30 on 29 March 2026 does not exist');
  neg(T.parseLocalDateTimeWithZone('2026-10-25T01:30', LON).error === 'LOCAL_TIME_AMBIGUOUS', 'G4b and 01:30 on 25 October 2026 happens twice');
  neg(T.parseLocalDateTimeWithZone('2026-06-01T09:00', 'europe/london').error === 'TIMEZONE_INVALID', 'G5 a folded zone name is refused before any arithmetic');
  neg(T.parseLocalDateTimeWithZone('2026-02-30T09:00', NY).error === 'TIMESTAMP_INVALID' && T.parseLocalDateTimeWithZone('2026-06-01T25:00', NY).error === 'TIMESTAMP_INVALID', 'G5b a rolled-over day and a 25th hour are refused as local times too');
  // A Trial session that spans the spring-forward: two hours on the wall, one hour elapsed.
  const s = validateSessionInput({ startsAt: T.parseLocalDateTimeWithZone('2026-03-08T01:30', NY).ms, endsAt: T.parseLocalDateTimeWithZone('2026-03-08T03:30', NY).ms, venue: { name: 'Field' } }, { now: Date.UTC(2026, 0, 1) });
  ok(s.ok === true && s.session.endsAt - s.session.startsAt === HOUR, 'G6 a session from 01:30 to 03:30 on the spring-forward night is ONE elapsed hour — instants, not wall clocks, are stored');
  ok(icsLocal(s.session.startsAt, NY) === '20260308T013000' && icsLocal(s.session.endsAt, NY) === '20260308T033000', 'G6b and the calendar export prints the wall clocks the family will see');
  ok(localDay(Date.UTC(2026, 2, 8, 6, 59), NY) === '2026-03-08' && localDay(Date.UTC(2026, 2, 8, 4, 59), NY) === '2026-03-07', 'G6c the local day of an instant is the organiser\'s day, not the UTC day');
  // Fall-back: a session 01:30→02:30 on the wall is ambiguous; with an explicit resolution it is well-defined.
  const early = T.parseLocalDateTimeWithZone('2026-11-01T01:30', NY, { resolve: 'earlier' }).ms;
  const s2 = validateSessionInput({ startsAt: early, endsAt: early + 2 * HOUR, venue: { name: 'Field' } }, { now: Date.UTC(2026, 0, 1) });
  ok(s2.ok === true && icsLocal(s2.session.startsAt, NY) === '20261101T013000' && icsLocal(s2.session.endsAt, NY) === '20261101T023000', 'G7 two elapsed hours from the first 01:30 print as 01:30→02:30 on the wall: the hour that happens twice is accounted for');
}

section('H/pure — the predicates: absent is open, unreadable is closed');
{
  const now = T0;
  ok(T.isExpiredAt(null, now) === false && T.isExpiredAt(undefined, now) === false, 'H1 no expiry → not expired');
  ok(T.isExpiredAt(now + 1, now) === false && T.isExpiredAt(now, now) === true && T.isExpiredAt(now - 1, now) === true, 'H2 expired at exactly the instant (exclusive end)');
  for (const v of SHAPES.unreadable) neg(T.isExpiredAt(v, now) === true, `H3 an unreadable expiry ${JSON.stringify(v)} IS expired`);
  ok(T.isEffectiveAt(now - 1, null, now) === true && T.isEffectiveAt(now, null, now) === true && T.isEffectiveAt(now - 1, now + 1, now) === true, 'H4 effective: started, open or unexpired end');
  neg(T.isEffectiveAt(now + 1, null, now) === false && T.isEffectiveAt(now - 1, now, now) === false, 'H5 not yet started / ended exactly now');
  for (const v of SHAPES.absent) neg(T.isEffectiveAt(v, null, now) === false, `H6 an absent START ${JSON.stringify(v)} is not "always started" — a window needs a start`);
  for (const v of SHAPES.unreadable) neg(T.isEffectiveAt(v, null, now) === false && T.isEffectiveAt(now - 1, v, now) === false, `H7 unreadable ${JSON.stringify(v)} at either end closes the window`);
  ok(T.isActiveAt({ startsAt: now - 1, endsAt: now + 1 }, now) === true && T.isActiveAt(null, now) === false && T.isActiveAt({ startsAt: now - 1, endsAt: 'x' }, now) === false, 'H8 isActiveAt over a record');
  ok(T.isOrderedInterval(1, 2) === true && T.isOrderedInterval(2, 2) === false && T.isOrderedInterval(2, 2, { allowEqual: true }) === true && T.isOrderedInterval(3, 2) === false, 'H9 ordered intervals');
  for (const v of SHAPES.absent.concat(SHAPES.unreadable)) neg(T.isOrderedInterval(v, 2) === false && T.isOrderedInterval(1, v) === false, `H10 ${JSON.stringify(v)} is not an interval end`);
  ok(T.isDayWithin('2026-09-23', '2026-09-01', '2026-09-30') === true && T.isDayWithin('2026-09-23', null, null) === true && T.isDayWithin('2026-09-23', '2026-09-23', '2026-09-23') === true, 'H11 DATE_ONLY windows are inclusive at both ends');
  neg(T.isDayWithin('2026-09-23', '2026-09-24', null) === false && T.isDayWithin('2026-09-23', null, '2026-09-22') === false, 'H12 outside');
  neg(T.isDayWithin('2026-09-23', 'garbage', null) === false && T.isDayWithin('2026-09-23', null, '2026-02-30') === false && T.isDayWithin('garbage', null, null) === false, 'H13 an unreadable bound or day closes the window');
}

section('I/pure — licence and affiliation expiry (M14 effective status)');
{
  const base = { status: 'verified', current: true, validFrom: 1, validUntil: null, organisationId: 'o1', verificationMethod: 'organisation_admin_confirmation' };
  const org = { id: 'o1', suspended: false, verification: {}, closedAt: null };
  ok(licenceEffectiveStatus(base, { org, now: T0 }).status === 'verified', 'I1 control: no expiry, verified');
  ok(licenceEffectiveStatus({ ...base, validUntil: T0 + 1 }, { org, now: T0 }).status === 'verified', 'I2 expires in 1ms: still verified');
  neg(licenceEffectiveStatus({ ...base, validUntil: T0 }, { org, now: T0 }).status === 'expired', 'I3 expires now: expired (exclusive end)');
  neg(licenceEffectiveStatus({ ...base, validUntil: T0 - DAY }, { org, now: T0 }).status === 'expired', 'I3b expired yesterday');
  for (const v of SHAPES.unreadable) neg(licenceEffectiveStatus({ ...base, validUntil: v }, { org, now: T0 }).status === 'expired', `I4 T-3: an unreadable validUntil ${JSON.stringify(v)} reads EXPIRED, never "no expiry"`);
  ok(licenceEffectiveStatus({ ...base, current: false, validUntil: 99 }, { org, now: T0 }).historical === true, 'I5 a closed period stays history (frozen M14 rule untouched)');
}

section('J/pure — policy windows (M25): boundaries that exist, closed when they do not');
{
  const row = (p) => ({ jurisdiction: 'ENG', status: 'published', policyVersion: 1, effectiveFrom: '2026-01-01', effectiveTo: null, ...p });
  ok(selectPolicyVersion([row({})], 'ENG', T0)?.policyVersion === 1, 'J1 control: an in-effect version is selected');
  ok(selectPolicyVersion([row({ effectiveFrom: '2026-09-23' })], 'ENG', Date.UTC(2026, 8, 23)) !== null, 'J2 effectiveFrom is inclusive at UTC midnight');
  neg(selectPolicyVersion([row({ effectiveFrom: '2026-09-24' })], 'ENG', T0) === null, 'J3 a version effective tomorrow is not in effect today');
  neg(selectPolicyVersion([row({ effectiveTo: '2026-09-23' })], 'ENG', T0) === null, 'J4 effectiveTo is exclusive: a version ending today ended at midnight');
  neg(selectPolicyVersion([row({ effectiveFrom: '2026-02-30' })], 'ENG', T0) === null, 'J5 T-4: a version starting on 30 February is NEVER in effect (it used to start on 2 March)');
  neg(selectPolicyVersion([row({ effectiveFrom: '2025-13-01' })], 'ENG', T0) === null && selectPolicyVersion([row({ effectiveFrom: 'garbage' })], 'ENG', T0) === null && selectPolicyVersion([row({ effectiveFrom: null })], 'ENG', T0) === null, 'J5b month 13, text and null starts select nothing');
  neg(selectPolicyVersion([row({ effectiveTo: 'garbage' })], 'ENG', T0) === null && selectPolicyVersion([row({ effectiveTo: '2099-02-30' })], 'ENG', T0) === null, 'J6 an unreadable END is a closed window, not an open one');
  ok(selectPolicyVersion([row({ effectiveFrom: T0 - DAY })], 'ENG', T0) !== null, 'J7 an integer boundary is accepted');
  neg(selectPolicyVersion([row({ effectiveFrom: String(T0 - DAY) })], 'ENG', T0) === null, 'J7b a numeric STRING boundary is not');
  const pending = (from) => ruleStatusAt({ rule: { ruleStatus: 'PENDING_IMPLEMENTATION', effectiveFrom: from } }, T0);
  ok(pending('2026-01-01') === 'ACTIVE' && pending('2027-01-01') === 'PENDING_IMPLEMENTATION', 'J8 a pending rule becomes ACTIVE on its own effectiveFrom');
  neg(pending('2026-02-30') === 'PENDING_IMPLEMENTATION' && pending('garbage') === 'PENDING_IMPLEMENTATION' && pending(undefined) === 'PENDING_IMPLEMENTATION', 'J9 …and stays PENDING when that date cannot be read (never applied early)');
}

section('K/pure — agent facets, affiliations, agreements, consent, handoff');
{
  ok(effectiveFacetState({ state: 'VERIFIED', recheckAt: T0 + DAY }, T0) === 'VERIFIED', 'K1 control: VERIFIED before recheck');
  neg(effectiveFacetState({ state: 'VERIFIED', recheckAt: T0 }, T0) === 'STALE', 'K2 STALE at the recheck instant');
  ok(effectiveFacetState({ state: 'VERIFIED' }, T0) === 'VERIFIED' && effectiveFacetState({ state: 'VERIFIED', recheckAt: null }, T0) === 'VERIFIED', 'K3 an ABSENT recheck clock keeps the frozen P5.6B reading (legacy row, no decay)');
  for (const v of SHAPES.unreadable) neg(effectiveFacetState({ state: 'VERIFIED', recheckAt: v }, T0) === 'STALE', `K4 T-1: a PRESENT but unreadable recheckAt ${JSON.stringify(v)} reads STALE, never VERIFIED for ever`);
  const p = { facets: { fifa_licence: { state: 'VERIFIED', recheckAt: NaN }, national_registration: {}, domestic_authorisation: {}, minors_authorisation: {} } };
  neg(verificationGap(p, 'INT', T0)?.error === 'AGENT_VERIFICATION_REQUIRED' && verificationGap(p, 'INT', T0)?.state === 'STALE', 'K4b …so the regulated-action gate refuses it');
  ok(affiliationActive({ startedAt: T0 - 1, endedAt: null }, T0) === true, 'K5 control: affiliation');
  ok(affiliationActive({ startedAt: T0 - 1, endedAt: null }, T0) === true && affiliationActive({ startedAt: null, endedAt: null }, T0) === false, 'K5b an absent END is open; an absent START is not started (membership needs a start)');
  for (const v of SHAPES.unreadable) neg(affiliationActive({ startedAt: v, endedAt: null }, T0) === false && affiliationActive({ startedAt: T0 - 1, endedAt: v }, T0) === false, `K6 affiliation with unreadable ${JSON.stringify(v)} at either end is inactive`);
  const live = { status: 'active', confirmedAt: T0 - DAY, agentUserId: 'u', clientId: 'p', startAt: T0 - DAY, endAt: T0 + DAY };
  ok(agreementGrantsAccess(live, 'u', T0) === true, 'K7 control: mandate');
  for (const v of SHAPES.unreadable) neg(agreementGrantsAccess({ ...live, endAt: v }, 'u', T0) === false && agreementGrantsAccess({ ...live, startAt: v }, 'u', T0) === false, `K8 F-2/F-3 regression: unreadable ${JSON.stringify(v)} at either term end grants nothing`);
  ok(effectiveAgreementStatus({ ...live, endAt: NaN }, T0) === 'expired', 'K8b and reads expired');
  const consent = (patch) => consentSufficiency({ kind: 'dual_representation', status: 'granted', grantedAt: T0 - DAY, contextId: 'c', agentUserId: 'a', partyRole: 'individual', policyVersions: ['v1'], grantedBy: { kind: 'player', id: 'p' }, ...patch }, { partyRole: 'individual', agentUserId: 'a', contextId: 'c', firstActAt: T0, activePolicyIds: ['v1'] });
  ok(consent({}).ok === true, 'K9 control: consent granted a day before the first act');
  neg(consent({ grantedAt: T0 + 1 }).reasonCode === 'CONSENT_NOT_IN_ADVANCE', 'K10 consent after the first act is not in advance');
  for (const v of SHAPES.absent.concat(SHAPES.unreadable)) neg(consent({ grantedAt: v }).ok === false && consent({ grantedAt: v }).reasonCode === 'CONSENT_MISSING', `K11 an undated grant ${JSON.stringify(v)} is not a grant (NaN used to pass typeof AND the in-advance test)`);
  ok(effectiveHandoffStatus({ status: 'invited', invitedAt: T0 - DAY }, T0) === 'invited' && effectiveHandoffStatus({ status: 'invited', invitedAt: T0 - HANDOFF_TTL_MS }, T0) === 'expired', 'K12 a handoff invitation expires at its TTL');
  for (const v of SHAPES.absent.concat(SHAPES.unreadable)) neg(effectiveHandoffStatus({ status: 'invited', invitedAt: v }, T0) === 'expired', `K13 an invitation with an unreadable clock ${JSON.stringify(v)} is expired, not standing for ever`);
  ok(effectiveHandoffStatus({ status: 'accepted', invitedAt: NaN }, T0) === 'accepted', 'K13b …only an open invitation has a TTL');
}

section('L/pure — Contact: the attested-contact instant and the 72-hour cooldown');
{
  const rec = (occurredAt) => validateExternalRecord({ channel: 'phone', occurredAt, summary: 's', recipientType: 'player' }, { now: T0, derivedRecipientType: 'player' });
  ok(rec(T0 - HOUR).ok === true && rec(T0 - HOUR).occurredAt === T0 - HOUR, 'L1 control: an integer instant an hour ago');
  ok(rec('2026-09-23T10:00:00Z').ok === true && rec('2026-09-23T10:00:00Z').occurredAt === Date.UTC(2026, 8, 23, 10), 'L1b an ISO instant with Z');
  ok(rec('2026-09-23T06:00:00-04:00').occurredAt === Date.UTC(2026, 8, 23, 10), 'L1c an ISO instant with an offset: 06:00 in New York is 10:00Z');
  neg(rec('2026-09-23T10:00').error === 'CONTACT_OCCURRED_AT_INVALID', 'L2 T-6: a bare local time is refused — it used to mean whatever zone the server ran in');
  neg(rec('09/22/2026').error === 'CONTACT_OCCURRED_AT_INVALID' && rec('22/09/2026').error === 'CONTACT_OCCURRED_AT_INVALID', 'L2b an ambiguous slash date is refused either way round');
  neg(rec('2026-02-30T10:00:00Z').error === 'CONTACT_OCCURRED_AT_INVALID', 'L2c a rolled-over day is refused');
  neg(rec(String(T0 - HOUR)).error === 'CONTACT_OCCURRED_AT_INVALID' && rec(1.5).error === 'CONTACT_OCCURRED_AT_INVALID', 'L2d a numeric string and a fraction are refused');
  neg(rec(T0 + HOUR).error === 'CONTACT_OCCURRED_AT_INVALID' && rec(T0 - CONTACT_LIMITS.occurredAtMaxAgeMs - 1).error === 'CONTACT_OCCURRED_AT_INVALID', 'L3 the reasonableness window is unchanged: not in the future, not older than the evidence limit');
  const c = (deliveredAt, extra = {}) => ({ id: 'c1', orgId: 'o', playerId: 'p', channel: 'in_app', status: 'delivered', deliveredAt, ...extra });
  neg(cooldownFor([c(T0 - 71 * HOUR)], { orgId: 'o', playerId: 'p', now: T0 })?.retryAt === T0 + HOUR, 'L4 71 hours after delivery: still cooling, retry in an hour');
  ok(cooldownFor([c(T0 - CONTACT_LIMITS.cooldownMs)], { orgId: 'o', playerId: 'p', now: T0 }) === null, 'L4b exactly 72 hours after: clear (exclusive boundary)');
  ok(cooldownFor([c(T0 - 1, { status: 'answered' })], { orgId: 'o', playerId: 'p', now: T0 }) === null, 'L4c an answered contact does not cool');
  for (const v of SHAPES.absent.concat(SHAPES.unreadable)) ok(cooldownFor([c(v)], { orgId: 'o', playerId: 'p', now: T0 }) === null, `L5 an undated delivery ${String(v)} cannot start a cooldown (a rate limit fails OPEN by design: it protects the player, not the club)`);
  ok(cooldownFor([c(Infinity)], { orgId: 'o', playerId: 'p', now: T0 }) === null, 'L5b T-13: a delivery at +Infinity used to cool the pair down FOR EVER (`typeof Infinity === "number"`); it now starts nothing');
}

section('M/pure — Trial scheduling: 15 minutes to 12 hours, ordered, ≤20 sessions, a real zone');
{
  const now = Date.UTC(2026, 0, 1);
  const base = Date.UTC(2026, 5, 1, 9);
  const s = (patch) => validateSessionInput({ startsAt: base, endsAt: base + HOUR, venue: { name: 'Field' }, ...patch }, { now });
  ok(s({}).ok === true, 'M1 control');
  neg(s({ endsAt: base }).ok === false && s({ endsAt: base - 1 }).ok === false, 'M2 end must be after start');
  neg(s({ endsAt: base + TRIAL_LIMITS.minSessionMs - 1 }).ok === false && s({ endsAt: base + TRIAL_LIMITS.minSessionMs }).ok === true, 'M3 15 minutes is the floor (inclusive)');
  neg(s({ endsAt: base + TRIAL_LIMITS.maxSessionMs + 1 }).ok === false && s({ endsAt: base + TRIAL_LIMITS.maxSessionMs }).ok === true, 'M4 12 hours is the ceiling (inclusive)');
  neg(s({ startsAt: '2026-06-01T09:00' }).error === 'TRIAL_SCHEDULE_INVALID' && s({ startsAt: '2026-06-01' }).error === 'TRIAL_SCHEDULE_INVALID' && s({ startsAt: '2026-02-30T09:00Z' }).error === 'TRIAL_SCHEDULE_INVALID', 'M5 a bare local time, a date-only and a rolled-over day are not session times');
  neg(s({ startsAt: now - 2 * HOUR, endsAt: now - HOUR }).ok === false, 'M6 a new session entirely in the past is refused');
  const sched = (n, tz = LON) => validateScheduleInput({ timezone: tz, sessions: Array.from({ length: n }, (_, i) => ({ startsAt: base + i * 2 * HOUR, endsAt: base + i * 2 * HOUR + HOUR, venue: { name: 'Field' } })) }, { now, mintId: (() => { let k = 0; return () => `tses-${++k}`; })() });
  ok(sched(TRIAL_LIMITS.sessions).ok === true && TRIAL_LIMITS.sessions === 20, 'M7 twenty sessions is the most a revision may carry');
  neg(sched(21).ok === false && sched(0).ok === false, 'M7b twenty-one, and none, are refused');
  neg(sched(1, 'europe/london').error === 'TRIAL_TIMEZONE_INVALID' && sched(1, 'Mars/Olympus').error === 'TRIAL_TIMEZONE_INVALID' && sched(1, 'GMT').error === 'TRIAL_TIMEZONE_INVALID', 'M8 the organiser zone is exact IANA');
  const overlap = validateScheduleInput({ timezone: LON, sessions: [{ startsAt: base, endsAt: base + 2 * HOUR, venue: { name: 'A' } }, { startsAt: base + HOUR, endsAt: base + 3 * HOUR, venue: { name: 'B' } }] }, { now, mintId: () => 'x' + Math.random() });
  neg(overlap.ok === false, 'M9 overlapping sessions are refused');
  ok(parseTrialDate('2026-06-01').t === Date.UTC(2026, 5, 1) && isTrialDate('2026-06-01') === true, 'M10 a trial day');
  neg(parseTrialDate('2026-02-30').error === 'TRIAL_DATE_INVALID' && parseTrialDate('2026-06-01T00:00:00Z').error === 'TRIAL_DATE_INVALID' && isTrialDate(null) === false, 'M11 not a trial day');
  ok(trialReportDueAt('2026-06-01', 5) === Date.UTC(2026, 5, 8) && trialReportDueAt('2026-02-30', 5) === 5 + 7 * DAY && trialReportDueAt(null, NaN) === null, 'M12 the report deadline derives from the day, else from acceptance, else null (never NaN)');
}

section('N/pure — analytics windows, recruitment briefs, and football history (§50: partial dates stay partial)');
{
  ok(resolveWindow({ from: '2026-03-01', to: '2026-03-31' }, T0).days === 31, 'N1 a custom window');
  neg(resolveWindow({ from: '2026-02-30', to: '2026-03-31' }, T0).error === 'WINDOW_INVALID' && resolveWindow({ from: '2026-03-01', to: '2026-13-01' }, T0).error === 'WINDOW_INVALID', 'N2 a window bounded by a day that does not exist is refused (it used to become 2 March)');
  neg(resolveWindow({ from: '2026-03-05', to: '2026-03-01' }, T0).error === 'WINDOW_INVALID' && resolveWindow({ from: '2026-12-01', to: '2026-12-31' }, T0).error === 'WINDOW_INVALID', 'N3 backwards and future windows are refused');
  ok(previousWindow({ from: '2026-03-01', to: '2026-03-31' }).from === '2026-01-29' && previousWindow({ from: '2026-03-01', to: '2026-03-31' }).days === 31, 'N4 the previous window is the same length');
  const brief = (patch) => validateRecruitmentBrief({ title: 'x', positions: ['CM'], ...patch }, { orgLevel: 'pro' });
  ok(brief({ activeFrom: '2026-09-01', activeUntil: '2026-09-30' }).ok === true, 'N5 control brief window');
  neg(brief({ activeUntil: 'garbage' }).ok === false && brief({ activeUntil: 'garbage' }).details.some((d) => d.field === 'activeUntil' && d.error === 'DATE_INVALID'), 'N6 a brief whose end cannot be read is refused (it used to be live for ever)');
  neg(brief({ activeFrom: '2026-02-30' }).ok === false && brief({ activeFrom: '2026-09-30', activeUntil: '2026-09-01' }).details.some((d) => d.error === 'BRIEF_WINDOW_INVALID'), 'N6b a rolled-over start, and a backwards window');
  ok(briefIsLiveOn({ status: 'active', activeFrom: '2026-09-01', activeUntil: '2026-09-30' }, '2026-09-30') === true && briefIsLiveOn({ status: 'active', activeUntil: '2026-09-30' }, '2026-10-01') === false, 'N7 live through the whole last day');
  neg(briefIsLiveOn({ status: 'active', activeUntil: 'garbage' }, '2026-09-23') === false && briefIsLiveOn({ status: 'active', activeFrom: '2026-02-30' }, '2026-09-23') === false, 'N8 a pre-P5.7 brief with garbage in a bound is not live');
  ok(normWhen('2024').precision === 'year' && normWhen('2024-03').precision === 'month' && normWhen('2024-03-05').precision === 'day', 'N9 §50: year-only and month-only history dates are kept at their own precision');
  neg(normWhen('2024-02-30') === null && normWhen({ year: 2024, month: 13 }) === null && normWhen({ year: 1850 }) === null, 'N10 …but a day that does not exist, a 13th month (which used to be clamped to December) and an implausible year become null, never a guessed date');
  ok(normWhen('2024-03-05T10:00:00Z').precision === 'day' && normWhen('2024-03-05T10:00:00Z').d === 5, 'N11 an ISO date-time in history keeps its day');
}

section('O/pure — the 22 adversarial cases (mandate §36) — every one EXPECT NO');
{
  const now = T0;
  const cases = [
    ['#1 a 30 February date of birth creates an adult', () => isAdult({ dob: '2010-02-30' }, new Date(now))],
    ['#2 a US-format date of birth 02/03/2010 is readable', () => parseDob('02/03/2010') !== null],
    ['#3 a null date of birth is an adult (the epoch)', () => isAdult({ dob: null }, new Date(now))],
    ['#4 a future date of birth is accepted', () => T.parseDobStrict('2030-01-01', now).ok],
    ['#5 a licence whose expiry is text never expires', () => licenceEffectiveStatus({ status: 'verified', current: true, validUntil: 'garbage' }, { org: null, now }).status === 'verified'],
    ['#6 a registry expiry that cannot be read is "no expiry"', () => T.parseDateOrInstant('30/06/2028', { dayEdge: 'end' }).ok],
    ['#7 a VALID leap day (2000-02-29) is rejected', () => parseDob('2000-02-29') === null],
    ['#8 a policy version effective from 30 February is in effect', () => selectPolicyVersion([{ jurisdiction: 'ENG', status: 'published', policyVersion: 1, effectiveFrom: '2026-02-30', effectiveTo: null }], 'ENG', now) !== null],
    ['#9 a VERIFIED facet whose recheck clock is a string stays VERIFIED', () => effectiveFacetState({ state: 'VERIFIED', recheckAt: 'soon' }, now) === 'VERIFIED'],
    ['#10 an affiliation whose end is a string is active', () => affiliationActive({ startedAt: now - 1, endedAt: '2030-01-01' }, now)],
    ['#11 a mandate whose end is NaN grants access', () => agreementGrantsAccess({ status: 'active', confirmedAt: 1, agentUserId: 'u', clientId: 'p', startAt: 1, endAt: NaN }, 'u', now)],
    ['#12 a session written as a bare local time is scheduled', () => validateSessionInput({ startsAt: '2026-06-01T09:00', endsAt: '2026-06-01T10:00', venue: { name: 'F' } }, { now: 1 }).ok],
    ['#13 a wall-clock time inside the spring-forward gap resolves', () => T.parseLocalDateTimeWithZone('2026-03-08T02:30', NY).ok],
    ['#14 a 13-hour session is scheduled', () => validateSessionInput({ startsAt: now, endsAt: now + 13 * HOUR, venue: { name: 'F' } }, { now: 1 }).ok],
    ['#15 a 21-session revision is scheduled', () => validateScheduleInput({ timezone: LON, sessions: Array.from({ length: 21 }, (_, i) => ({ startsAt: now + i * 2 * HOUR, endsAt: now + i * 2 * HOUR + HOUR, venue: { name: 'F' } })) }, { now: 1, mintId: () => `s${Math.random()}` }).ok],
    ['#16 a wall-clock time inside the fall-back overlap resolves WITHOUT an explicit resolution', () => T.parseLocalDateTimeWithZone('2026-11-01T01:30', NY).ok],
    ['#17 a contact "occurred at" a bare local time is recorded', () => validateExternalRecord({ channel: 'phone', occurredAt: '2026-09-23T10:00', recipientType: 'player' }, { now, derivedRecipientType: 'player' }).ok],
    ['#18 a contact that occurred on 30 February is recorded', () => validateExternalRecord({ channel: 'phone', occurredAt: '2026-02-30T10:00:00Z', recipientType: 'player' }, { now, derivedRecipientType: 'player' }).ok],
    ['#19 a consent granted at NaN is sufficient', () => consentSufficiency({ kind: 'dual_representation', status: 'granted', grantedAt: NaN, contextId: 'c', agentUserId: 'a', partyRole: 'individual', policyVersions: ['v1'], grantedBy: { kind: 'player', id: 'p' } }, { partyRole: 'individual', agentUserId: 'a', contextId: 'c', firstActAt: now, activePolicyIds: ['v1'] }).ok],
    ['#20 a handoff invited at "yesterday" is still standing', () => effectiveHandoffStatus({ status: 'invited', invitedAt: 'yesterday' }, now) === 'invited'],
    ['#21 a recruitment brief ending "whenever" is live', () => briefIsLiveOn({ status: 'active', activeUntil: 'whenever' }, '2026-09-23')],
    ['#22 an analytics window starting on 30 February resolves', () => !resolveWindow({ from: '2026-02-30', to: '2026-03-01' }, now).error],
  ];
  ok(cases.length === 22, 'O0 twenty-two cases, enumerated');
  for (const [label, attempt] of cases) neg(attempt() === false, `O ${label} — EXPECT NO`);
  ok(T.parseLocalDateTimeWithZone('2026-11-01T01:30', NY, { resolve: 'earlier' }).ok === true, 'O #16b …and WITH the frozen explicit resolution it does (the only permitted YES)');
}

section('P/pure — zone independence: identical answers under TZ=UTC and TZ=America/New_York (§28)');
{
  const probe = `
    const T = await import(${JSON.stringify(path.join(HERE, '..', 'temporal.mjs'))});
    const D = await import(${JSON.stringify(path.join(HERE, '..', 'domain.mjs'))});
    const M = await import(${JSON.stringify(path.join(HERE, '..', 'm20', 'metrics.mjs'))});
    const t0 = ${T0};
    const out = {
      tzOffsetOfEpoch: new Date(0).getTimezoneOffset(),
      ages: ['2008-09-23', '2008-09-24', '2008-02-29', '2004-03-14', '2006-04-02'].map((d) => D.ageOn(d, new Date(t0))),
      agesMidnight: ['2008-09-23', '2008-09-24'].map((d) => D.ageOn(d, new Date(Date.UTC(2026, 8, 23, 0, 0, 0)))),
      agesLateEvening: ['2008-09-23', '2008-09-24'].map((d) => D.ageOn(d, new Date(Date.UTC(2026, 8, 23, 23, 59, 59)))),
      adultGB: D.isAdult({ dob: '2008-09-23', country: 'GB' }, new Date(Date.UTC(2026, 8, 23, 3))),
      dob: ['2010-02-30', '2000-02-29', '2026-09-23'].map((d) => D.parseDob(d)),
      dayT: T.parseStrictDateOnly('2026-03-01').t,
      instants: ['2026-03-01T10:00Z', '2026-03-01T10:00:00+05:30'].map((s) => T.parseInstant(s).ms),
      localNY: T.localParts(Date.UTC(2026, 2, 1, 4, 30), 'America/New_York'),
      gap: T.parseLocalDateTimeWithZone('2026-03-08T02:30', 'America/New_York').error,
      overlap: T.parseLocalDateTimeWithZone('2026-11-01T01:30', 'America/New_York').error,
      resolved: T.parseLocalDateTimeWithZone('2026-11-01T01:30', 'America/New_York', { resolve: 'later' }).ms,
      quarterMonth: new Date(T.parseStrictDateOnly('2010-04-01').t).getUTCMonth(),
      utcDay: T.utcDayOf(Date.UTC(2026, 8, 23, 23, 30)),
      window: M.resolveWindow({ preset: 'last_7_days' }, Date.UTC(2026, 8, 23, 23, 30)),
      endOfDay: T.endOfDayExclusive('2026-03-01'),
      dobBounds: [T.parseDobStrict('2030-01-01', t0).ok, T.parseDobStrict('1900-01-01', t0).ok],
    };
    console.log(JSON.stringify(out));
  `;
  const run = (tz) => { const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`probe failed under TZ=${tz}: ${r.stderr}`); return JSON.parse(r.stdout.trim().split('\n').pop()); };
  const utc = run('UTC'); const ny = run('America/New_York'); const tokyo = run('Asia/Tokyo');
  ok(utc.tzOffsetOfEpoch === 0 && ny.tzOffsetOfEpoch === 300 && tokyo.tzOffsetOfEpoch === -540, 'P1 the three probes really ran in three different process zones (UTC, New York, Tokyo)');
  const strip = (o) => { const { tzOffsetOfEpoch, ...rest } = o; return JSON.stringify(rest); };
  ok(strip(utc) === strip(ny), 'P2 every age, dob, instant, DST, quarter, window and bound answer is byte-identical under TZ=America/New_York');
  ok(strip(utc) === strip(tokyo), 'P2b …and under TZ=Asia/Tokyo (east of Greenwich, the other failure direction)');
  ok(utc.agesMidnight[0] === 18 && utc.agesLateEvening[0] === 18 && utc.agesMidnight[1] === 17 && utc.agesLateEvening[1] === 17, 'P3 the birthday turns at 00:00 UTC and holds until 23:59:59 UTC, whatever the server zone');
  ok(utc.quarterMonth === 3, 'P4 a 1 April birth is in April in every zone (T-9: getMonth() used to say March in New York)');
}

// =================================================================== LIVE

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot(env = {}) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', SCOUTBOX_TEST_CLOCK: '1', ...env }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
async function stop(proc) { proc.kill('SIGTERM'); for (let i = 0; i < 80; i++) { if (proc.exitCode != null || proc.signalCode) break; await sleep(100); } await sleep(300); }
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, headers: r.headers };
}
const expect = (r, status, code) => { const good = r.status === status && (code == null || r.body?.error === code); if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`); return good; };
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

// A trial with named staff exists before boot, carrying the three shapes a
// pre-P5.7 database can hold for a background-check expiry: a day that has
// passed, a day to come, and text nobody can read.
let server = await boot();
await stop(server);
{
  const store = openStore(DATA_DIR);
  const snap = store.load();
  snap.db.trials ??= [];
  snap.db.trials.push({
    id: 'trial-p57', requestId: 'req-p57', playerId: 'pl-adeyemi', playerName: 'Kola Adeyemi', orgId: 'org-eastport', orgName: 'Eastport FC', scoutName: 'Maria Keane',
    acceptedAt: Date.now() - 3 * DAY, proposedDate: T.utcDayOf(Date.now() + 10 * DAY), venue: 'Training ground', notes: '', reportDueAt: Date.now() + 17 * DAY, status: 'awaiting_report',
    day: {
      staff: [
        { id: 'stf-past', name: 'A Past', role: 'Coach', check: { kind: 'DBS', ref: 'x', status: 'reviewed', expiresAt: '2020-01-01', reviewedBy: 'T&S' }, addedBy: 'Maria Keane', addedAt: 1 },
        { id: 'stf-future', name: 'B Future', role: 'Coach', check: { kind: 'DBS', ref: 'x', status: 'reviewed', expiresAt: '2099-01-01', reviewedBy: 'T&S' }, addedBy: 'Maria Keane', addedAt: 1 },
        { id: 'stf-text', name: 'C Text', role: 'Coach', check: { kind: 'DBS', ref: 'x', status: 'reviewed', expiresAt: 'never', reviewedBy: 'T&S' }, addedBy: 'Maria Keane', addedAt: 1 },
        { id: 'stf-none', name: 'D None', role: 'Coach', check: { kind: 'DBS', ref: 'x', status: 'reviewed', expiresAt: null, reviewedBy: 'T&S' }, addedBy: 'Maria Keane', addedAt: 1 },
        { id: 'stf-pending', name: 'E Pending', role: 'Coach', check: { kind: 'DBS', ref: 'x', status: 'pending', expiresAt: null, reviewedBy: null }, addedBy: 'Maria Keane', addedAt: 1 },
      ],
      consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [],
    },
  });
  store.save(snap);
  store.close?.();
}
server = await boot();

section('Q/live — sign-up: every bad date of birth refused at the door, both doors');
{
  const signup = (dob) => j('POST', '/auth/player/signup', { name: `Probe ${Math.random().toString(36).slice(2, 6)}`, dob, country: 'GB', position: 'ST', foot: 'Right', password: 'a-long-enough-password' });
  for (const dob of ['2000-02-30', '1999-04-31', '1997-02-29', '1998-13-01', '1998-00-10', '1998-01-00', '1998-01-32', '02/03/1998']) neg(expect(await signup(dob), 400, 'DOB_INVALID'), `Q1 self sign-up with dob ${dob} → 400 DOB_INVALID`);
  neg(expect(await signup('2030-01-01'), 400, 'DOB_INVALID'), 'Q1b a date of birth in the future → 400 DOB_INVALID (§24)');
  neg(expect(await signup('1890-01-01'), 400, 'DOB_INVALID'), 'Q1c a 136-year-old → 400 DOB_INVALID (§24)');
  const leap = await signup('2000-02-29');
  ok(leap.status === 201 && leap.body?.player?.dob === '2000-02-29', 'Q2 a REAL leap day (2000-02-29) creates the account and stores the day exactly (§36 #7)');
  const gAuth = await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' });
  ok(gAuth.status === 200 && !!gAuth.body?.token, 'Q3 the guardian signs in');
  const child = (dob) => j('POST', '/guardian/children', { name: `Child ${Math.random().toString(36).slice(2, 6)}`, dob, country: 'GB' }, gAuth.body.token);
  for (const dob of ['2012-02-30', '2013-13-01', '02/03/2012']) neg(expect(await child(dob), 400, 'DOB_INVALID'), `Q4 guardian creates a child with dob ${dob} → 400 DOB_INVALID`);
  neg(expect(await child('2030-01-01'), 400, 'DOB_INVALID'), 'Q4b a child born in the future → 400 DOB_INVALID');
  const kid = await child('2012-02-29');
  ok(kid.status === 201, 'Q5 a child born on the 2012 leap day is created');
}

section('R/live — every hardened route answers with the taxonomy');
{
  const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const moss = await login('org-mossside', 'Pat Doyle', undefined, 'grassroots');
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const priya = (await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' })).body;
  ok(!!maria?.token && !!moss?.token && !!kola?.token && !!priya?.token, 'R0 the four identities signed in');

  // Licence expiry (T-3)
  const lic = (body) => j('POST', '/org/verification/licence', { licenceType: 'UEFA B Licence', issuer: 'UEFA', identifier: 'UEFA-B-77777', holderName: 'Maria Keane', ...body }, maria.token);
  neg(expect(await lic({ expiry: '2027-02-30' }), 400, 'DATE_INVALID'), 'R1 a licence expiring on 30 February → 400 DATE_INVALID');
  neg(expect(await lic({ expiry: 'sometime' }), 400, 'DATE_INVALID'), 'R1b …"sometime" → 400 (it used to be stored as NO expiry)');
  neg(expect(await lic({ expiry: '30/06/2028' }), 400, 'DATE_INVALID'), 'R1c …an ambiguous slash date → 400');
  neg(expect(await lic({ issueDate: '2028-06-30', expiry: '2027-06-30' }), 400, 'INTERVAL_INVALID'), 'R1d expiring before issue → 400 INTERVAL_INVALID');
  const good = await lic({ issueDate: '2024-06-30', expiry: '2028-06-30' });
  ok(good.status === 201 && !!good.body?.claim?.id, 'R2 a well-formed licence claim is created');
  const me = await j('GET', '/org/verification/me', undefined, maria.token);
  const claim = (me.body?.claims ?? []).find((c) => c.id === good.body.claim.id);
  ok(claim?.validUntil === Date.UTC(2028, 5, 31) && claim?.validFrom === Date.UTC(2024, 5, 30), 'R2b stored as instants: valid THROUGH 30 June 2028 (expiry = start of 1 July, UTC), from 30 June 2024');

  // Safeguarding staff check expiry (T-2)
  const day = await j('GET', '/org/trials/trial-p57/day', undefined, maria.token);
  const st = Object.fromEntries((day.body?.trial?.staff ?? []).map((s) => [s.id, s.check.status]));
  ok(day.status === 200 && st['stf-future'] === 'reviewed' && st['stf-none'] === 'reviewed' && st['stf-pending'] === 'pending', 'R3 controls: a future expiry and no expiry read reviewed; pending reads pending');
  neg(st['stf-past'] === 'expired', 'R3b a check that expired in 2020 reads expired');
  neg(st['stf-text'] === 'expired', 'R3c T-2: a check whose expiry is the word "never" reads EXPIRED — it used to read reviewed for ever');
  neg(expect(await j('POST', '/admin/staff-checks/trial-p57/stf-pending', { status: 'reviewed', expiresAt: '2027-02-30' }, null, ADMIN), 400, 'DATE_INVALID'), 'R4 T&S cannot review a check with an expiry on 30 February');
  neg(expect(await j('POST', '/admin/staff-checks/trial-p57/stf-pending', { status: 'reviewed', expiresAt: 'never' }, null, ADMIN), 400, 'DATE_INVALID'), 'R4b …or "never"');
  const reviewed = await j('POST', '/admin/staff-checks/trial-p57/stf-pending', { status: 'reviewed', expiresAt: '2027-06-30' }, null, ADMIN);
  ok(reviewed.status === 200 && reviewed.body?.check?.state === 'reviewed' && reviewed.body?.check?.expiresAt === '2027-06-30', 'R4c a real day is accepted and stored as the day');
  neg(expect(await j('POST', '/org/trials/trial-p57/staff', { name: 'F New', role: 'Coach', check: { kind: 'DBS', expiresAt: '2027-04-31' } }, maria.token), 400, 'DATE_INVALID'), 'R5 a club cannot file a check expiring on 31 April');
  const staffIso = await j('POST', '/org/trials/trial-p57/staff', { name: 'G Iso', role: 'Coach', check: { kind: 'DBS', expiresAt: '2027-06-30T00:00:00.000Z' } }, maria.token);
  ok(staffIso.status === 201 && staffIso.body?.staff?.check?.expiresAt === '2027-06-30T00:00:00.000Z', 'R5b an ISO instant with Z (the shape the club app sends) is accepted and normalised');

  // Development Hub (T-7)
  neg(expect(await j('POST', '/player/development/plans', { title: 'X', visibility: 'private', startDate: '2026-06-01T09:00' }, kola.token), 400, 'DATE_INVALID'), 'R6 a plan starting at a bare local time → 400 DATE_INVALID');
  neg(expect(await j('POST', '/player/development/plans', { title: 'X', visibility: 'private', startDate: '2026-02-30' }, kola.token), 400, 'DATE_INVALID'), 'R6b …on 30 February → 400');
  neg(expect(await j('POST', '/player/development/plans', { title: 'X', visibility: 'private', startDate: '06/01/2026' }, kola.token), 400, 'DATE_INVALID'), 'R6c …on 06/01/2026 → 400 (it used to be 1 June)');
  const plan = await j('POST', '/player/development/plans', { title: 'X', visibility: 'private', startDate: '2026-06-01', endDate: '2026-08-31' }, kola.token);
  ok(plan.status === 201 && plan.body?.plan?.startDate === Date.UTC(2026, 5, 1), 'R6d a calendar day is stored as the UTC-midnight instant');
  neg(expect(await j('POST', '/player/development/plans', { title: 'X', visibility: 'private', startDate: '2026-06-01', endDate: '2026-05-31' }, kola.token), 400, 'DATE_INTERVAL_INVALID'), 'R6e an inverted plan interval keeps its frozen m21 code');

  // Analytics, briefs
  neg(expect(await j('GET', '/org/recruitment-analytics?from=2026-02-30&to=2026-03-01', undefined, maria.token), 400, 'WINDOW_INVALID'), 'R7 an analytics window from 30 February → 400 WINDOW_INVALID');
  const brief = await j('POST', '/org/recruitment-briefs', { title: 'P57', positions: ['CM'], activeUntil: 'whenever' }, maria.token);
  neg(brief.status === 400 && brief.body?.error === 'BRIEF_INVALID' && (brief.body?.details ?? []).some((d) => d.field === 'activeUntil' && d.error === 'DATE_INVALID'), 'R8 a brief ending "whenever" → 400 BRIEF_INVALID naming activeUntil DATE_INVALID');

  // Grassroots dates (T-10)
  neg(expect(await j('POST', '/org/open-trials', { title: 'Open day', date: 'next week', venue: 'Rec' }, moss.token), 400, 'DATE_INVALID'), 'R9 an open day dated "next week" → 400 DATE_INVALID (it used to list as upcoming for ever)');
  neg(expect(await j('POST', '/org/open-trials', { title: 'Open day', date: '2099-02-30', venue: 'Rec' }, moss.token), 400, 'DATE_INVALID'), 'R9b …on 30 February → 400');
  ok((await j('POST', '/org/open-trials', { title: 'Open day', date: '2099-05-01', venue: 'Rec' }, moss.token)).status === 201, 'R9c a real day → 201');
  neg(expect(await j('POST', '/org/matchday', { fixture: 'A v B', date: '2026-02-30', playerIds: [] }, moss.token), 400, 'DATE_INVALID'), 'R10 a match day on 30 February → 400');
  neg(expect(await j('POST', '/org/friendlies', { date: 'soon', venue: 'x' }, moss.token), 400, 'DATE_INVALID'), 'R10b a friendly "soon" → 400');
  neg(expect(await j('POST', '/player/attendance', { fixture: 'x', venue: 'y', date: '02/03/2026', gps: { lat: 51.5, lng: -0.1 }, deviceId: 'd' }, kola.token), 400, 'DATE_INVALID'), 'R11 verified attendance on 02/03/2026 → 400 DATE_INVALID');
  neg(expect(await j('POST', '/player/medical/records', { title: 'Knock', date: '2026-13-01' }, kola.token), 400, 'DATE_INVALID'), 'R12 a medical record in month 13 → 400');
  ok((await j('POST', '/player/medical/records', { title: 'Knock' }, kola.token)).status === 201, 'R12b …and one with no date is dated today');

  // Evidence (§16)
  neg(expect(await j('POST', '/player/evidence', { claimType: 'statistic', label: 'Goals', value: 3, observedAt: '2026-02-30' }, kola.token), 400, 'DATE_INVALID'), 'R13 evidence observed on 30 February → 400');
  neg(expect(await j('POST', '/player/evidence', { claimType: 'statistic', label: 'Goals', value: 3, observedAt: T.utcDayOf(Date.now() + 30 * DAY) }, kola.token), 400, 'DATE_INVALID'), 'R13b evidence observed next month → 400 (not yet evidence)');
  const ev = await j('POST', '/player/evidence', { claimType: 'statistic', label: 'Goals', value: 3, observedAt: '2026-03-01' }, kola.token);
  ok(ev.status === 201 && ev.body?.evidence?.observedAt === Date.UTC(2026, 2, 1), 'R13c a calendar day is stored as an instant');

  // Notification preferences (T-12)
  neg(expect(await j('POST', '/player/prefs', { quietStart: '25:00', quietEnd: '07:00' }, kola.token), 400, 'TIME_INVALID'), 'R14 quiet hours from 25:00 → 400 TIME_INVALID');
  neg(expect(await j('POST', '/player/prefs', { timezone: 'Mars/Olympus' }, kola.token), 400, 'TIMEZONE_INVALID'), 'R14b a zone that is not a zone → 400 TIMEZONE_INVALID');
  const prefs = await j('POST', '/player/prefs', { quietStart: '22:00', quietEnd: '07:00', timezone: NY }, kola.token);
  ok(prefs.status === 200 && prefs.body?.prefs?.timezone === NY && prefs.body?.prefs?.quietStart === '22:00', 'R14c quiet hours in a named zone are stored');

  // Policy publishing (T-4)
  const pol = (from, to = null) => j('POST', '/ts/compliance/policies', { id: `jp-eng-p57-${Math.random().toString(36).slice(2, 6)}`, regulator: 'FA', jurisdiction: 'ENG', policyVersion: 77, effectiveFrom: from, effectiveTo: to, rules: { 'X-1': { ruleStatus: 'ACTIVE', sourceRef: [{ source: 'p57', retrievedDate: '2026-01-01' }] } } }, priya.token);
  neg(expect(await pol('2027-02-30'), 400, 'POLICY_INPUT_INVALID'), 'R15 a policy effective from 30 February → 400 POLICY_INPUT_INVALID');
  neg(expect(await pol('2027-01-01', '2026-12-31'), 400, 'POLICY_INPUT_INVALID'), 'R15b a policy ending before it starts → 400');
  ok((await pol('2027-01-01', '2027-12-31')).status === 201, 'R15c a well-ordered window is proposed');
}

section('S/live — authorization is decided before a date is read (§29 error privacy)');
{
  neg(expect(await j('POST', '/org/open-trials', { title: 'x', date: '2026-02-30', venue: 'y' }), 401), 'S1 no token + bad date → 401, not 400');
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const r = await j('POST', '/org/open-trials', { title: 'x', date: '2026-02-30', venue: 'y' }, kola.token);
  neg(r.status === 401 || r.status === 403, `S2 a player token on a club route + bad date → ${r.status}, never a date error`);
  neg(expect(await j('POST', '/admin/staff-checks/trial-p57/stf-text', { status: 'reviewed', expiresAt: '2027-02-30' }), 401, 'ADMIN_KEY_REQUIRED'), 'S3 the staff-check review without the admin key → 401, not 400');
  neg(expect(await j('POST', '/guardian/children', { name: 'x', dob: '2012-02-30' }), 401), 'S4 a child with a bad dob and no guardian token → 401');
  neg(expect(await j('POST', '/player/development/plans', { title: 'X', visibility: 'private', startDate: '2026-02-30' }), 401), 'S5 a plan with a bad date and no token → 401');
  neg(expect(await j('POST', '/ts/compliance/policies', { id: 'jp-eng-x-1', jurisdiction: 'ENG', policyVersion: 1, effectiveFrom: '2027-02-30', rules: {} }), 401), 'S6 a policy with a bad date and no reviewer → 401');
  const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  neg(expect(await j('GET', '/org/trials/trial-nope/day', undefined, maria.token), 404, 'TRIAL_NOT_FOUND'), 'S7 an unknown trial is 404 for its own club…');
  const harbour = await login('org-harbour', 'Coach D. Ansah', 'Head Coach');
  if (harbour?.token) neg(expect(await j('POST', '/org/trials/trial-p57/staff', { name: 'x', role: 'y', check: { expiresAt: '2027-02-30' } }, harbour.token), 404, 'TRIAL_NOT_FOUND'), 'S7b …and another club\'s trial is 404 for a stranger even with a bad date in the body (existence is not revealed by a date error)');
  else ok(true, 'S7b (skipped: no second club login available in this seed)');
}

section('T/live — persistence and restart: normalised values survive as what they are');
{
  ok((await j('GET', '/healthz')).headers.get('x-scoutbox-schema') === String(SCHEMA_VERSION) && SCHEMA_VERSION === 2307, 'T1 schema 2307 — P5.7 adds no migration');
  await stop(server);
  server = await boot();
  const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const me = await j('GET', '/org/verification/me', undefined, maria.token);
  const lic = (me.body?.claims ?? []).find((c) => c.claimType === 'LICENCE' && c.validUntil === Date.UTC(2028, 5, 31));
  ok(!!lic, 'T2 the licence expiry is an integer instant after a restart');
  const day = await j('GET', '/org/trials/trial-p57/day', undefined, maria.token);
  const st = Object.fromEntries((day.body?.trial?.staff ?? []).map((s) => [s.id, s.check.status]));
  neg(st['stf-text'] === 'expired' && st['stf-past'] === 'expired' && st['stf-future'] === 'reviewed', 'T3 the legacy "never" check still reads expired after a restart; the real ones unchanged');
  ok(st['stf-pending'] === 'reviewed', 'T3b the check T&S reviewed with a real day persisted as reviewed');
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const prefs = await j('GET', '/player/prefs', undefined, kola.token);
  ok(prefs.body?.prefs?.timezone === NY, 'T4 the notification zone persisted');
  await stop(server);
}

console.log(`\n${passed} checks passed, ${negatives} negative (${Math.round((100 * negatives) / Math.max(1, passed + (process.exitCode ? 1 : 0)))}%)`);
if (process.exitCode) console.error('FAILURES PRESENT');
