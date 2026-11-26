// The Trial date rules and the notification taxonomy behind the trial dates, minors and erasure battery
// (e2e/recruitment/trialDatesMinorsAndErasure.mjs), checked in this process: the one Trial date validator against
// every malformed shape (A), and the guardian decision's place in the notification categories (C0).
import {
  parseTrialDate,
  isTrialDate,
  trialReportDueAt,
  validateTrialDetails,
  chooseTrialSlot,
  TRIAL_REPORT_WINDOW_MS,
  TRIAL_DATE_SYNTAX,
  TRIAL_DETAIL_LIMITS,
  TRIAL_REPORT_FIELDS,
} from '../../../domain.ts';
import { CATEGORIES, TYPE_CATEGORY, categoryOf } from '../../../domains/platform/notificationPrefs.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/trialDatesMinorsAndErasure');

const DAY = 24 * 3600 * 1000;

// ============================================================ A — pure validator
section('A — one Trial date validator, every malformed shape refused before persistence');
{
  const malformed = [
    'not-a-date',
    '2026-13-99',
    '2026-02-31',
    {},
    [],
    0,
    NaN,
    'NaN',
    ' 2026-10-03',
    '2026-10-03 ',
    '\t2026-10-03',
    '2026-10-03T10:00',
    '2026-10-03T00:00:00Z',
    '1999-12-31',
    '2101-01-01',
    '0000-01-01',
    '9999-12-31',
    '2026-1-3',
    '20261003',
    true,
    false,
    1e12,
    -1,
    '2026-02-29',
    '2026-04-31',
    '2026-00-10',
    '2026-10-00',
    '2026/10/03',
    '03-10-2026',
    'today',
    'next tuesday-ish',
    Symbol.for('x'),
    () => {},
    new Date('2026-10-03'),
    { proposedDate: '2026-10-03' },
    ['2026-10-03'],
  ];
  for (const m of malformed) {
    const r = parseTrialDate(m);
    neg(
      r.ok === false && r.error === 'TRIAL_DATE_INVALID' && r.expected === TRIAL_DATE_SYNTAX,
      `A1 ${typeof m === 'symbol' ? 'Symbol' : typeof m === 'function' ? 'function' : (JSON.stringify(m) ?? String(m))} is refused as TRIAL_DATE_INVALID`,
    );
  }
  for (const absent of ['', null, undefined]) {
    const r = parseTrialDate(absent);
    ok(
      r.ok === true && r.value === null && r.t === null,
      `A2 ${JSON.stringify(absent) ?? 'undefined'} means "no date", never an error and never a fabricated day`,
    );
  }
  const good = parseTrialDate('2026-10-03');
  ok(
    good.ok && good.value === '2026-10-03' && good.t === Date.UTC(2026, 9, 3),
    'A3 a calendar day parses to its own string and its UTC midnight',
  );
  ok(parseTrialDate('2028-02-29').ok === true, 'A3b a real leap day is accepted');
  neg(parseTrialDate('2027-02-29').ok === false, 'A3c a leap day in a non-leap year is refused');
  ok(
    parseTrialDate('2000-01-01').ok && parseTrialDate('2100-12-31').ok,
    'A3d the accepted range is inclusive at both ends',
  );
  neg(
    isTrialDate('') === false &&
      isTrialDate(null) === false &&
      isTrialDate('bad') === false &&
      isTrialDate('2026-10-03') === true,
    'A4 isTrialDate is true only for a real stored day',
  );

  ok(
    trialReportDueAt('2026-10-03', 5) === Date.UTC(2026, 9, 3) + TRIAL_REPORT_WINDOW_MS,
    'A5 the deadline is trial day + 7 days, from the day not the acceptance',
  );
  ok(
    trialReportDueAt(null, 1000) === 1000 + TRIAL_REPORT_WINDOW_MS,
    'A5b with no day it is acceptance + 7 days, from the clock the caller passed',
  );
  neg(
    trialReportDueAt('garbage', 1000) === 1000 + TRIAL_REPORT_WINDOW_MS,
    'A5c a legacy garbage day falls back to the acceptance clock, never NaN',
  );
  neg(
    trialReportDueAt(null, NaN) === null &&
      trialReportDueAt(null, undefined) === null &&
      trialReportDueAt('bad', 'bad') === null,
    'A5d with nothing finite to derive from the answer is null, not NaN',
  );
  ok(TRIAL_REPORT_WINDOW_MS === 7 * DAY, 'A5e the window is exactly seven days');

  const full = validateTrialDetails({
    proposedDate: '2026-10-03',
    altSlots: ['2026-10-10', '2026-10-17'],
    venue: 'Eastport Dome',
    notes: 'Bring boots.',
  });
  ok(
    full.ok &&
      JSON.stringify(full.details) ===
        JSON.stringify({
          proposedDate: '2026-10-03',
          altSlots: ['2026-10-10', '2026-10-17'],
          venue: 'Eastport Dome',
          notes: 'Bring boots.',
        }),
    'A6 valid details come back canonical and untouched',
  );
  ok(
    JSON.stringify(validateTrialDetails({}).details) ===
      JSON.stringify({ proposedDate: null, altSlots: [], venue: null, notes: '' }),
    'A6b nothing given is a date-to-be-confirmed invitation with empty logistics',
  );
  ok(
    validateTrialDetails(null).ok && validateTrialDetails('text').ok && validateTrialDetails(42).ok,
    'A6c a non-object body is treated as no details, not a crash',
  );
  neg(
    validateTrialDetails({ proposedDate: 'bad' }).error === 'TRIAL_DATE_INVALID' &&
      validateTrialDetails({ proposedDate: 'bad' }).field === 'proposedDate',
    'A7 a bad proposed date is refused and names its field',
  );
  neg(validateTrialDetails({ altSlots: 'x' }).error === 'TRIAL_SLOTS_INVALID', 'A7b altSlots must be a list');
  neg(
    validateTrialDetails({ altSlots: { 0: '2026-10-10', length: 1 } }).error === 'TRIAL_SLOTS_INVALID',
    'A7c an array-like object is not a list',
  );
  neg(
    validateTrialDetails({ altSlots: ['2026-10-10', '2026-10-17', '2026-10-24'] }).error === 'TRIAL_SLOTS_INVALID',
    `A7d more than ${TRIAL_DETAIL_LIMITS.altSlots} slots is refused, not truncated`,
  );
  neg(
    validateTrialDetails({ altSlots: ['2026-10-10', 'bad'] }).error === 'TRIAL_DATE_INVALID' &&
      validateTrialDetails({ altSlots: ['2026-10-10', 'bad'] }).field === 'altSlots',
    'A7e a bad slot is refused as a date, naming altSlots',
  );
  neg(
    validateTrialDetails({ altSlots: [''] }).error === 'TRIAL_SLOTS_INVALID' &&
      validateTrialDetails({ altSlots: [null] }).error === 'TRIAL_SLOTS_INVALID',
    'A7f an empty slot is refused (there is no such thing as an alternative "no date")',
  );
  neg(
    validateTrialDetails({ proposedDate: '2026-10-03', altSlots: ['2026-10-03'] }).error === 'TRIAL_SLOTS_INVALID',
    'A7g a slot equal to the proposed day is refused',
  );
  neg(
    validateTrialDetails({ altSlots: ['2026-10-10', '2026-10-10'] }).error === 'TRIAL_SLOTS_INVALID',
    'A7h duplicate slots are refused',
  );
  neg(
    validateTrialDetails({ venue: 'x'.repeat(TRIAL_DETAIL_LIMITS.venue + 1) }).error === 'TRIAL_VENUE_INVALID',
    'A8 an over-long venue is refused, not clamped',
  );
  ok(validateTrialDetails({ venue: 'x'.repeat(TRIAL_DETAIL_LIMITS.venue) }).ok, 'A8b exactly the limit is accepted');
  neg(
    validateTrialDetails({ venue: 'Gate B\nEND:VEVENT' }).error === 'TRIAL_VENUE_INVALID' &&
      validateTrialDetails({ venue: 'a\rb' }).error === 'TRIAL_VENUE_INVALID' &&
      validateTrialDetails({ venue: 'a\u0000b' }).error === 'TRIAL_VENUE_INVALID',
    'A8c a venue with a line break or control character is refused (it is written into a calendar file)',
  );
  neg(
    validateTrialDetails({ venue: {} }).error === 'TRIAL_VENUE_INVALID' &&
      validateTrialDetails({ venue: 5 }).error === 'TRIAL_VENUE_INVALID' &&
      validateTrialDetails({ venue: [] }).error === 'TRIAL_VENUE_INVALID',
    'A8d a non-text venue is refused',
  );
  ok(
    validateTrialDetails({ venue: '' }).details.venue === null &&
      validateTrialDetails({ venue: null }).details.venue === null,
    'A8e an empty venue is no venue',
  );
  neg(
    validateTrialDetails({ notes: 'x'.repeat(TRIAL_DETAIL_LIMITS.notes + 1) }).error === 'TRIAL_NOTES_INVALID' &&
      validateTrialDetails({ notes: 5 }).error === 'TRIAL_NOTES_INVALID' &&
      validateTrialDetails({ notes: {} }).error === 'TRIAL_NOTES_INVALID',
    'A9 over-long or non-text notes are refused',
  );
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) {
    const o = JSON.parse(`{"${key}": {"proposedDate": "bad"}, "proposedDate": "2026-10-03"}`);
    const r = validateTrialDetails(o);
    neg(
      r.ok === true && r.details.proposedDate === '2026-10-03' && !(key in r.details && Object.hasOwn(r.details, key)),
      `A10 a "${key}" key in the body neither leaks nor changes the details`,
    );
  }

  ok(
    chooseTrialSlot({ proposedDate: '2026-10-03', altSlots: ['2026-10-10'] }, '2026-10-10').date === '2026-10-10',
    'A11 an offered alternative is chosen',
  );
  ok(
    chooseTrialSlot({ proposedDate: '2026-10-03', altSlots: ['2026-10-10'] }, undefined).date === '2026-10-03' &&
      chooseTrialSlot({ proposedDate: '2026-10-03' }, '').date === '2026-10-03' &&
      chooseTrialSlot({ proposedDate: '2026-10-03' }, null).date === '2026-10-03',
    'A11b no choice means the proposed day',
  );
  const unknown = chooseTrialSlot({ proposedDate: '2026-10-03', altSlots: ['2026-10-10'] }, '2026-10-04');
  neg(
    unknown.ok === false &&
      unknown.error === 'TRIAL_SLOT_INVALID' &&
      JSON.stringify(unknown.offered) === JSON.stringify(['2026-10-03', '2026-10-10']),
    'A12 a day the club never offered is refused and the offered days are listed',
  );
  for (const v of [{}, [], 0, true, 42, ['2026-10-03'], { toString: () => '2026-10-03' }]) {
    neg(
      chooseTrialSlot({ proposedDate: '2026-10-03' }, v).error === 'TRIAL_SLOT_INVALID',
      `A12b a ${JSON.stringify(v)} slot is refused, not coerced`,
    );
  }
  neg(
    chooseTrialSlot({ proposedDate: 'garbage' }, 'garbage').date === null &&
      chooseTrialSlot({ proposedDate: 'garbage' }, undefined).date === null,
    'A13 a legacy request whose stored day is garbage yields no date — never the garbage, never an invented day',
  );
  neg(
    chooseTrialSlot(null, undefined).date === null && chooseTrialSlot('x', undefined).date === null,
    'A13b no details at all is an undated acceptance',
  );
  neg(
    chooseTrialSlot({ proposedDate: null }, '2026-10-03').error === 'TRIAL_SLOT_INVALID',
    'A13c a slot cannot be chosen when nothing was offered',
  );

  // date boundaries — UTC calendar days only; there is no time-of-day and no timezone in this model, so DST cannot move a deadline
  ok(
    trialReportDueAt('2026-12-31', 0) === Date.UTC(2027, 0, 7),
    'A14 a year-boundary trial day derives a deadline in the next year',
  );
  ok(
    trialReportDueAt('2026-02-28', 0) === Date.UTC(2026, 2, 7) &&
      trialReportDueAt('2028-02-29', 0) === Date.UTC(2028, 2, 7),
    'A14b end-of-month and leap-day trial days derive correctly',
  );
  ok(
    trialReportDueAt('2026-03-29', 0) - Date.UTC(2026, 2, 29) === 7 * DAY &&
      trialReportDueAt('2026-10-25', 0) - Date.UTC(2026, 9, 25) === 7 * DAY,
    'A14c the window is exactly 7 × 24 h across the European DST switches — UTC days, no local-time drift',
  );
  ok(
    parseTrialDate('2026-12-31').t === Date.UTC(2026, 11, 31) &&
      parseTrialDate('2027-01-01').t === parseTrialDate('2026-12-31').t + DAY,
    'A14d consecutive days across the year boundary are one day apart',
  );
}

// ============================================================ C0 — pure taxonomy
section('C0 — the guardian decision is a request outcome in the notification taxonomy');
{
  ok(
    TYPE_CATEGORY.guardian_decision === 'messages' && categoryOf('guardian_decision') === 'messages',
    'C0a guardian_decision → messages ("Messages and requests")',
  );
  ok(
    CATEGORIES.messages.default === true && CATEGORIES.messages.mandatory === false,
    'C0b that category is on by default for every existing, new and migrated person, and may be muted like every other request outcome',
  );
  ok(
    TYPE_CATEGORY.accepted === 'messages' && TYPE_CATEGORY.declined === 'messages',
    'C0c the club-side outcome rows live in the same category — one taxonomy, no parallel system',
  );
  neg(
    TYPE_CATEGORY.update === 'discovery_nudges' && CATEGORIES.discovery_nudges.default === false,
    'C0d `update` still means a discovery nudge (off by default) — the type was wrong for the child, the category was not changed to fit it',
  );
  // A feature must not make its own traffic unmutable to get attention. Besides
  // security, `compliance` is the one deliberate exception: it carries regulatory
  // review, consent and verification, where muting would mute an obligation rather
  // than a preference. Pinned as a set so adding a third has to change this line.
  neg(
    Object.keys(CATEGORIES)
      .filter((k) => CATEGORIES[k].mandatory)
      .sort()
      .join() === 'compliance,security_account',
    'C0e the mandatory categories are still exactly two — security_account and compliance; no milestone has quietly added a third',
  );
}

done();
